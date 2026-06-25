import cron from "node-cron";
import { processRecurringTransactions } from "./jobs/transaction.job";
import { processReportJob } from "./jobs/report.job";
import { logger } from "../utils/logger";

const scheduleJob = (name: string, time: string, job: Function) => {
  logger.info(`Scheduling ${name} at ${time}`);

  return cron.schedule(
    time,
    async () => {
      try {
        await job();
        logger.info(`${name} completed`);
      } catch (error) {
        logger.error(`${name} failed`, error);
      }
    },
    {
      scheduled: true,
      timezone: "UTC",
    }
  );
};

export const startJobs = () => {
  return [
    scheduleJob("Transactions", "5 0 * * *", processRecurringTransactions),

    //run 2:30am every first of the month
    scheduleJob("Reports", "30 2 1 * *", processReportJob),
  ];
};
