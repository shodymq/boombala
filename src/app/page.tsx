import { getAttractions } from "@/services/attractions";
import { getBirthdayPackages } from "@/services/birthdays";
import { getPrimaryContact } from "@/services/config";
import { getFaq } from "@/services/faq";
import { getMembership } from "@/services/memberships";
import { getPricing } from "@/services/pricing";
import { getMenu } from "@/services/menu";
import { Hero } from "@/components/home/Hero";
import { Entertainment } from "@/components/home/Entertainment";
import { Prices } from "@/components/home/Prices";
import { BirthdayShowcase } from "@/components/home/BirthdayShowcase";
import { MembershipSection } from "@/components/home/MembershipSection";
import { Faq } from "@/components/home/Faq";
import { Contacts } from "@/components/home/Contacts";
import { CafeTeaser } from "@/components/home/CafeTeaser";
import { getSiteUrl } from "@/lib/site-url";

const siteUrl = getSiteUrl();

const websiteJsonLd = {
  "@context": "https://schema.org",
  "@type": "WebSite",
  "@id": `${siteUrl}/#website`,
  name: "Boom Bala",
  alternateName: "Бум Бала",
  url: siteUrl,
  inLanguage: "ru",
  publisher: { "@id": `${siteUrl}/#business` },
} as const;

export default async function Home() {
  const [attractions, pricing, packages, membership, faq, menu] = await Promise.all([
    getAttractions(),
    getPricing(),
    getBirthdayPackages(),
    getMembership(),
    getFaq(),
    getMenu(),
  ]);
  const contact = getPrimaryContact();

  return (
    // One root element: after a client navigation Next scrolls to the first node of the page, and with
    // several root nodes it ended up on a later sibling (the page opened below its heading).
    <div>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(websiteJsonLd).replace(/</g, "\\u003c") }}
      />
      <Hero />
      <Entertainment attractions={attractions} />
      <Prices pricing={pricing} membership={membership} />
      <BirthdayShowcase packages={packages} />
      <MembershipSection membership={membership} contactHref={contact.href} />
      <CafeTeaser catalog={menu} />
      <Faq items={faq} />
      <Contacts />
    </div>
  );
}
