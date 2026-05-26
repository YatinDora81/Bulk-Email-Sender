import { Router } from "express";
import sendRoutes from "./send.route";

const router = Router();

router.use("/send", sendRoutes);

export default router;
