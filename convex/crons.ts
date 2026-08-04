import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Heartbeats arrive every 4s and become stale after 20s. A 10s sweep keeps
// worst-case expiry bounded at 30s while halving idle cron invocations.
crons.interval("expire stale CrowdCut cameras", { seconds: 10 }, internal.participants.expireStale, {});

export default crons;
