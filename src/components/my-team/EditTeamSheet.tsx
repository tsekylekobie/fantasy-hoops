"use client";

// Edit team: rename the team, change its abbreviation, and upload, replace or
// remove its logo. The picked image is center-cropped to a square and scaled
// to LOGO_PX in a canvas here, so the upload (and what Postgres stores) stays
// small; the server still checks the real type from the bytes.
// Saves go to PATCH /api/team/profile and PUT/DELETE /api/team/profile/logo.
import { useEffect, useRef, useState } from "react";
import TeamBadge from "@/components/TeamBadge";
import {
  TEAM_ABBREVIATION,
  TEAM_LOGO_TYPES,
  TEAM_NAME_LENGTH,
  type FantasyTeamSummary,
  type TeamProfileUpdate,
} from "@/lib/types";
import styles from "./EditTeamSheet.module.css";

const LOGO_PX = 256;
/** Originals can be big phone photos; they're downscaled before upload. */
const MAX_SOURCE_BYTES = 15 * 1024 * 1024;

interface Props {
  team: FantasyTeamSummary;
  open: boolean;
  /** The commissioner editing someone else's team: send its id explicitly. */
  asCommissioner?: boolean;
  onClose: () => void;
  onSaved: (team: FantasyTeamSummary) => void;
}

/** Pending logo change: a new image (with its preview URL) or removal. */
type LogoChange = { kind: "new"; blob: Blob; preview: string } | { kind: "remove" } | null;

export default function EditTeamSheet({ team, open, asCommissioner = false, onClose, onSaved }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(team.name);
  const [abbr, setAbbr] = useState(team.abbreviation);
  const [logo, setLogo] = useState<LogoChange>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      setName(team.name);
      setAbbr(team.abbreviation);
      setLogo(null);
      setError(null);
      dialog.showModal();
    } else if (!open && dialog.open) dialog.close();
  }, [open, team]);

  // Free the preview's object URL when it's replaced or the sheet closes.
  const preview = logo?.kind === "new" ? logo.preview : null;
  useEffect(() => () => {
    if (preview) URL.revokeObjectURL(preview);
  }, [preview]);

  const trimmedName = name.trim().replace(/\s+/g, " ");
  const nameError =
    trimmedName.length < TEAM_NAME_LENGTH.min || trimmedName.length > TEAM_NAME_LENGTH.max
      ? `${TEAM_NAME_LENGTH.min}–${TEAM_NAME_LENGTH.max} characters.`
      : null;
  const abbrError = TEAM_ABBREVIATION.test(abbr) ? null : "2–4 letters or digits, with at least one letter.";
  const profileChanged = trimmedName !== team.name || abbr !== team.abbreviation;
  const changed = profileChanged || logo !== null;
  const shownLogo = logo?.kind === "new" ? logo.preview : logo?.kind === "remove" ? null : team.logoUrl;

  async function pick(file: File | undefined) {
    if (fileRef.current) fileRef.current.value = "";
    if (!file) return;
    setError(null);
    if (!(TEAM_LOGO_TYPES as readonly string[]).includes(file.type)) {
      setError("Choose a PNG, JPEG or WebP image.");
      return;
    }
    if (file.size > MAX_SOURCE_BYTES) {
      setError("That image is too large. Choose one under 15 MB.");
      return;
    }
    try {
      const blob = await squareLogo(file);
      setLogo({ kind: "new", blob, preview: URL.createObjectURL(blob) });
    } catch {
      setError("That file couldn’t be read as an image.");
    }
  }

  async function save() {
    if (saving || nameError || abbrError || !changed) return;
    setSaving(true);
    setError(null);
    let latest = team;
    try {
      if (profileChanged) {
        const body: TeamProfileUpdate = {
          ...(asCommissioner ? { teamId: team.id } : {}),
          ...(trimmedName !== team.name ? { name: trimmedName } : {}),
          ...(abbr !== team.abbreviation ? { abbreviation: abbr } : {}),
        };
        latest = await send("/api/team/profile", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      }
      const q = asCommissioner ? `?team=${team.id}` : "";
      if (logo?.kind === "new") {
        latest = await send(`/api/team/profile/logo${q}`, { method: "PUT", headers: { "Content-Type": logo.blob.type }, body: logo.blob });
      } else if (logo?.kind === "remove") {
        latest = await send(`/api/team/profile/logo${q}`, { method: "DELETE" });
      }
      onSaved(latest);
      onClose();
    } catch (err) {
      // A name change may have saved before the logo failed: keep the page in step.
      if (latest !== team) onSaved(latest);
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className={styles.dialog}
      aria-labelledby="edit-team-title"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className={styles.hd}>
          <h2 id="edit-team-title" className={styles.title}>Edit team</h2>
          <button type="button" className={styles.x} aria-label="Close" onClick={onClose}>
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M3 3l12 12M15 3L3 15" />
            </svg>
          </button>
        </div>

        <div className={styles.body}>
          <div className={styles.logoRow}>
            <TeamBadge className={styles.preview} team={{ abbreviation: abbr || team.abbreviation, logoUrl: shownLogo }} />
            <div className={styles.logoText}>
              <span className={styles.label}>Logo</span>
              <span className={styles.hint}>PNG, JPEG or WebP. Cropped to a square.</span>
              <div className={styles.logoBtns}>
                <button type="button" className={styles.btn} onClick={() => fileRef.current?.click()} disabled={saving}>
                  {shownLogo ? "Replace" : "Upload"}
                </button>
                {shownLogo && (
                  <button
                    type="button"
                    className={styles.btn}
                    disabled={saving}
                    onClick={() => setLogo(team.logoUrl ? { kind: "remove" } : null)}
                  >
                    Remove
                  </button>
                )}
              </div>
              <input
                ref={fileRef}
                className={styles.file}
                type="file"
                accept={TEAM_LOGO_TYPES.join(",")}
                aria-label="Logo image"
                tabIndex={-1}
                onChange={(e) => void pick(e.target.files?.[0])}
              />
            </div>
          </div>

          <label className={styles.field}>
            <span className={styles.label}>Team name</span>
            <input
              className={styles.input}
              value={name}
              maxLength={TEAM_NAME_LENGTH.max + 8}
              autoComplete="off"
              aria-invalid={nameError !== null}
              onChange={(e) => setName(e.target.value)}
            />
            {nameError && <span className={styles.fieldError}>{nameError}</span>}
          </label>

          <label className={styles.field}>
            <span className={styles.label}>Abbreviation</span>
            <input
              className={`${styles.input} ${styles.abbr}`}
              value={abbr}
              maxLength={4}
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              aria-invalid={abbrError !== null}
              onChange={(e) => setAbbr(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))}
            />
            <span className={abbrError ? styles.fieldError : styles.hint}>{abbrError ?? "Shown where there’s no logo, and in short lists."}</span>
          </label>

          {error && <p className={styles.error} role="alert">{error}</p>}
        </div>

        <div className={styles.ft}>
          <button type="button" className={styles.btn} onClick={onClose}>Cancel</button>
          <button type="submit" className={`${styles.btn} ${styles.pri}`} disabled={saving || !changed || nameError !== null || abbrError !== null}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </dialog>
  );
}

async function send(url: string, init: RequestInit): Promise<FantasyTeamSummary> {
  const res = await fetch(url, init);
  const json = (await res.json().catch(() => null)) as (FantasyTeamSummary & { error?: string }) | null;
  if (!res.ok || !json) throw new Error(json?.error ?? `Request failed (${res.status}).`);
  return json;
}

/** Center-crops `file` to a square and scales it to LOGO_PX (WebP where the browser can encode it, else PNG). */
async function squareLogo(file: File): Promise<Blob> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    if (side === 0) throw new Error("empty image");
    const out = Math.min(LOGO_PX, side);
    const canvas = document.createElement("canvas");
    canvas.width = out;
    canvas.height = out;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no canvas");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, out, out);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", 0.9));
    if (!blob) throw new Error("encode failed");
    return blob;
  } finally {
    URL.revokeObjectURL(url);
  }
}
