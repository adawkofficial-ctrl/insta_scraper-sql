import "./preload_server_only.cjs";
import "dotenv/config";
import { getUnipileClient } from "../src/lib/services/unipile";

async function testResolve() {
  const unipile = getUnipileClient();
  const accounts = await unipile.getAccounts();
  const active = accounts[0];
  console.log("Active account:", active.id, active.name);

  try {
    const res = await unipile.resolveInstagramUser("loopfrag.official", active.id);
    console.log("Resolved loopfrag.official:", res);
  } catch (err) {
    console.error("Resolve error:", err);
  }
}

testResolve();
