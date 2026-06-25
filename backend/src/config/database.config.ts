import mongoose from "mongoose";
import { Env } from "./env.config";
import { logger } from "../utils/logger";

const connectDatabase = async () => {
  try {
    await mongoose.connect(Env.MONGO_URI, {
      serverSelectionTimeoutMS: 8000,
      socketTimeoutMS: 45000,
      connectTimeoutMS: 30000,
    });
    logger.info("Connected to MongoDB database");
  } catch (error) {
    logger.error("Error connecting to MongoDB database:", error);
    process.exit(1);
  }
};

export default connectDatabase;
