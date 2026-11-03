// Railway Infrastructure as Code: the project's services and their settings.
// Railway doesn't read this on deploy; apply changes by hand (README, "Deploying"):
//   railway config plan    # preview
//   railway config apply   # apply
// Secrets are preserve(): set their values in the Railway dashboard, never here.
import { defineRailway, github, postgres, preserve, project, service } from "railway/iac";

const REPO = "tsekylekobie/fantasy-hoops";

export default defineRailway(() => {
  const db = postgres("Postgres");

  const shared = {
    DATABASE_URL: db.env.DATABASE_URL,
    BALLDONTLIE_API_KEY: preserve(),
    BALLDONTLIE_BASE_URL: "https://api.balldontlie.io/v1",
    BALLDONTLIE_RPM: "60",
    WORKER_TIME_ZONE: "America/New_York",
  };

  // Migrates before each deploy; a failed migration stops the deploy.
  const web = service("web", {
    source: github(REPO, { branch: "main" }),
    build: "npm run build",
    preDeploy: "npm run db:migrate",
    start: "npm run start",
    deploy: { restartPolicyType: "ON_FAILURE", restartPolicyMaxRetries: 10 },
    env: {
      ...shared,
      GOOGLE_CLIENT_ID: preserve(),
      GOOGLE_CLIENT_SECRET: preserve(),
    },
  });

  // Runs from source with tsx, so no build step. Exactly one: its API rate limit is per process.
  const worker = service("worker", {
    source: github(REPO, { branch: "main" }),
    build: "echo 'worker runs from source with tsx; no build step'",
    start: "npm run worker",
    replicas: 1,
    deploy: { restartPolicyType: "ALWAYS" },
    env: shared,
  });

  return project("fantasy-hoops", { resources: [db, web, worker] });
});
