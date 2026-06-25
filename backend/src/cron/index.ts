import { startJobs } from "./scheduler";
import { logger } from "../utils/logger";

export const initializeCrons = async () => {
  try {
    const jobs = startJobs();
    logger.info(`⏰ ${jobs.length} cron jobs initialized`);
    return jobs;
  } catch (error) {
    logger.error("CRON INIT ERROR:", error);
    return [];
  }
};
