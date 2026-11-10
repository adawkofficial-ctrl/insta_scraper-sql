import "./preload_server_only.cjs";
import "dotenv/config";
import { evaluateProfileRelevance, decideRelevance } from "../src/lib/services/discovery/lead-relevance";

const helloPakistan = {
  profileUrl: "https://www.instagram.com/hellopakistan",
  username: "hellopakistan",
  fullName: "HELLO! Pakistan",
  biography: "Pakistan's premier lifestyle and fashion magazine.",
  category: "Magazine",
  followers: 1700000,
  externalUrl: "https://www.hmagpak.com/14-Sep-2026/gilded-hour-luxury-fashion",
};
const globalCampaign = {
  intent: "top magazines in Pakistan",
  location: null,
  category: "Magazine",
};
const ev = evaluateProfileRelevance(helloPakistan as any, globalCampaign);
const dec = decideRelevance(ev);
console.log("ev:", JSON.stringify(ev, null, 2));
console.log("dec:", JSON.stringify(dec, null, 2));
