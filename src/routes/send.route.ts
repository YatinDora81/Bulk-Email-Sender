import { Router } from "express";
import { sendOne, sendAll, getSentEmails } from "../controllers/send.controller";

const router = Router();

router.post("/one", sendOne);
router.post("/all", sendAll);
router.get("/emails", getSentEmails);

export default router;
