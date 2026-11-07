"use client";

// "Injury alerts" in the user menu: turns Web Push on or off for this browser.
// The worker notifies a manager when a player on their roster gets a worse
// injury status (src/lib/push/send.ts); public/sw.js shows the notification,
// even with no tab open. Hidden when the server has no VAPID keys.
// iPhone/iPad: push only works from the Home Screen app (iOS 16.4+), so in a
// Safari tab this says how to get there instead.
import { useEffect, useState } from "react";
import type { PushConfigResponse, PushSubscribeRequest, PushUnsubscribeRequest } from "@/lib/types";
import styles from "./UserMenu.module.css";

type State = "loading" | "hidden" | "install" | "denied" | "off" | "on";

function isIos(): boolean {
  return /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function pushSupported(): boolean {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

/** The VAPID public key (base64url) as the bytes pushManager.subscribe wants. */
function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const b64 = (base64url + "=".repeat((4 - (base64url.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function currentSubscription(): Promise<PushSubscription | null> {
  const reg = await navigator.serviceWorker.getRegistration("/");
  return (await reg?.pushManager.getSubscription()) ?? null;
}

async function saveOnServer(sub: PushSubscription, confirm: boolean): Promise<void> {
  const body: PushSubscribeRequest = { subscription: sub.toJSON() as PushSubscribeRequest["subscription"] };
  const res = await fetch(`/api/me/push${confirm ? "" : "?quiet=1"}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `Request failed (${res.status}).`);
}

export default function PushToggle() {
  const [state, setState] = useState<State>("loading");
  const [key, setKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async (): Promise<State> => {
      const cfg = (await (await fetch("/api/me/push")).json()) as PushConfigResponse;
      if (!cfg.publicKey) return "hidden";
      setKey(cfg.publicKey);
      if (!pushSupported()) return isIos() ? "install" : "hidden";
      if (Notification.permission === "denied") return "denied";
      const sub = await currentSubscription();
      if (!sub) return "off";
      // Keeps the server's copy current (it may have dropped an expired one) without a notification.
      await saveOnServer(sub, false).catch(() => {});
      return "on";
    })()
      .then((s) => !cancelled && setState(s))
      .catch(() => !cancelled && setState("hidden"));
    return () => {
      cancelled = true;
    };
  }, []);

  async function turnOn() {
    if (!key) return;
    setBusy(true);
    setError(null);
    try {
      // Asked first, straight from the tap: Safari only prompts from a user gesture.
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setState(permission === "denied" ? "denied" : "off");
        return;
      }
      await navigator.serviceWorker.register("/sw.js", { scope: "/" });
      const reg = await navigator.serviceWorker.ready;
      const sub =
        (await reg.pushManager.getSubscription()) ??
        (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) }));
      try {
        await saveOnServer(sub, true);
      } catch (err) {
        await sub.unsubscribe().catch(() => {});
        throw err;
      }
      setState("on");
    } catch (err) {
      setError((err as Error).message || "Couldn't turn on alerts.");
    } finally {
      setBusy(false);
    }
  }

  async function turnOff() {
    setBusy(true);
    setError(null);
    try {
      const sub = await currentSubscription();
      if (sub) {
        const body: PushUnsubscribeRequest = { endpoint: sub.endpoint };
        await fetch("/api/me/push", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        await sub.unsubscribe();
      }
      setState("off");
    } catch (err) {
      setError((err as Error).message || "Couldn't turn off alerts.");
    } finally {
      setBusy(false);
    }
  }

  if (state === "loading" || state === "hidden") return null;

  if (state === "install" || state === "denied") {
    return (
      <div className={styles.hint} role="note">
        <span className={styles.hintTitle}>Injury alerts</span>
        {state === "install"
          ? "On iPhone or iPad: tap Share, then Add to Home Screen, and turn them on from there."
          : "Notifications are blocked for this site. Allow them in your browser's site settings."}
      </div>
    );
  }

  return (
    <>
      <button
        type="button"
        role="menuitemcheckbox"
        aria-checked={state === "on"}
        className={`${styles.item} ${styles.toggleItem}`}
        onClick={state === "on" ? turnOff : turnOn}
        disabled={busy}
      >
        <span>Injury alerts</span>
        <span className={state === "on" ? styles.on : styles.off}>{busy ? "…" : state === "on" ? "On" : "Off"}</span>
      </button>
      {error && (
        <p className={styles.hint} role="alert">
          {error}
        </p>
      )}
    </>
  );
}
