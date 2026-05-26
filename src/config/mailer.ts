import nodemailer from "nodemailer";
import path from "path";

let transporter: nodemailer.Transporter | null = null;

function getTransporter(): nodemailer.Transporter {
  if (transporter) return transporter;
  transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: process.env.SMTP_EMAIL,
      pass: process.env.SMTP_PASSWORD,
    },
  });
  return transporter;
}

export async function sendEmail(params: {
  to: string;
  subject: string;
  html: string;
}): Promise<void> {
  const senderName = process.env.SENDER_NAME || "Yatin Dora";

  await getTransporter().sendMail({
    from: `"${senderName}" <${process.env.SMTP_EMAIL}>`,
    to: params.to,
    subject: params.subject,
    html: params.html,
    attachments: [
      {
        filename: "Yatin-SDE-1.pdf",
        path: path.join(process.cwd(), "Yatin-SDE-1.pdf"),
      },
    ],
  });
}

export async function verifySmtp(): Promise<boolean> {
  try {
    await getTransporter().verify();
    console.log("✓ SMTP connection verified");
    return true;
  } catch {
    console.log("✗ SMTP connection failed — check credentials");
    return false;
  }
}
