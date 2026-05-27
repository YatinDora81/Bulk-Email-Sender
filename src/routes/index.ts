import { Router } from "express";
import sendRoutes from "./send.route";
import trackingRoutes from "./tracking.route";

const router = Router();

router.use("/send", sendRoutes);
router.use("/tracking", trackingRoutes);

export default router;
