import "server-only";

import { promises as dns } from "node:dns";

export type DnsCheckStatus = "PASS" | "FAIL" | "UNKNOWN";

export type EmailDnsHealth = {
  domain: string;
  spf: DnsCheckStatus;
  dkim: DnsCheckStatus;
  dmarc: DnsCheckStatus;
  details: {
    spfRecord: string | null;
    dkimRecord: string | null;
    dmarcRecord: string | null;
  };
  checkedAt: string;
};

export type TxtResolver = (name: string) => Promise<string[][]>;

const defaultTxtResolver: TxtResolver = async (name) => dns.resolveTxt(name);

export async function checkEmailDns(
  fromAddress: string,
  dkimSelector: string | null | undefined,
  resolver: TxtResolver = defaultTxtResolver,
): Promise<EmailDnsHealth> {
  const domain = fromAddress.split("@")[1]?.toLowerCase() ?? "";
  const checkedAt = new Date().toISOString();
  if (!domain) {
    return {
      domain,
      spf: "FAIL",
      dkim: "FAIL",
      dmarc: "FAIL",
      details: { spfRecord: null, dkimRecord: null, dmarcRecord: null },
      checkedAt,
    };
  }

  const readTxt = async (name: string): Promise<string | null> => {
    try {
      const rows = await resolver(name);
      return rows.map((parts) => parts.join("")).join(" ").trim() || null;
    } catch {
      return null;
    }
  };

  const spfRecord = await readTxt(domain);
  const spf = spfRecord && /v=spf1\b/i.test(spfRecord) ? "PASS" : "FAIL";

  const selector = dkimSelector?.trim();
  const dkimRecord = selector ? await readTxt(`${selector}._domainkey.${domain}`) : null;
  const dkim = dkimRecord && /v=DKIM1\b/i.test(dkimRecord) ? "PASS" : "FAIL";

  const dmarcRecord = await readTxt(`_dmarc.${domain}`);
  const dmarc = dmarcRecord && /v=DMARC1\b/i.test(dmarcRecord) ? "PASS" : "FAIL";

  return {
    domain,
    spf: spf as DnsCheckStatus,
    dkim: dkim as DnsCheckStatus,
    dmarc: dmarc as DnsCheckStatus,
    details: { spfRecord, dkimRecord, dmarcRecord },
    checkedAt,
  };
}
