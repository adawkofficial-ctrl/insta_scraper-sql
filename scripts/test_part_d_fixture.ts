import { extractContactsFromHtml, findContactSubpageUrls } from "../src/lib/services/enrichment/website-contact-extractor";
import { normalizePhone } from "../src/lib/services/contact/contact-parser";

const sampleHtml = `
<!DOCTYPE html>
<html>
<head><title>Rawalpindi Medical Center</title></head>
<body>
  <h1>Welcome to Rawalpindi Care</h1>
  <p>For appointments, email us at <a href="mailto:appointments@rawalpindicare.com.pk">our desk</a> or call +92 51 5551234.</p>
  <footer>
    <a href="/contact-us">Contact Us</a>
    <a href="/about">About Us</a>
    <a href="https://facebook.com/rawalpindicare">Facebook</a>
  </footer>
</body>
</html>
`;

const contacts = extractContactsFromHtml(sampleHtml);
console.log("Extracted contacts:", contacts);
console.log("Normalized phone:", normalizePhone(contacts.phone));
const subpages = findContactSubpageUrls(sampleHtml, "https://rawalpindicare.com.pk");
console.log("Subpages:", subpages);
