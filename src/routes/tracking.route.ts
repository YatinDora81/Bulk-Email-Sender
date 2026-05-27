import { Router } from "express";
import {
  getOpenTrackingList,
  getOpenTrackingForEmail,
  syncTrackingToStorage,
} from "../controllers/tracking.controller";
import { trackingPixel } from "../controllers/tracking-pixel.controller";

const router = Router();

router.get("/pixel", trackingPixel);
router.get("/opens", getOpenTrackingList);
router.get("/opens/lookup", getOpenTrackingForEmail);
router.post("/sync", syncTrackingToStorage);

export default router;
