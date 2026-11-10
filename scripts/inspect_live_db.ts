import "./preload_server_only.cjs";
import "dotenv/config";
import { getPrismaClient } from "../src/lib/db/prisma";

async function main() {
  const prisma = getPrismaClient();
  const users = await prisma.user.findMany({ select: { id: true, email: true } });
  console.log("Users:", users);
  const campaigns = await prisma.campaign.findMany({ select: { id: true, name: true, userId: true, intent: true } });
  console.log("Campaigns:", campaigns);
  const senders = await prisma.instagramSenderAccount.findMany({ select: { id: true, username: true, status: true, connectionMethod: true, userId: true, unipileAccountId: true } });
  console.log("Senders (InstagramSenderAccount):", senders);
  const notifConfigs = await prisma.notificationConfig.findMany();
  console.log("NotificationConfigs:", notifConfigs);
  const companyProfiles = await prisma.companyProfile.findMany();
  console.log("CompanyProfiles:", companyProfiles.length);
}

main().then(() => process.exit(0)).catch(err => {
  console.error(err);
  process.exit(1);
});
