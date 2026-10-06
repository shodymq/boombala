import { getAttractions } from "@/services/attractions";
import { getBirthdayPackages } from "@/services/birthdays";
import { getPrimaryContact } from "@/services/config";
import { getFaq } from "@/services/faq";
import { getMembership } from "@/services/memberships";
import { getPricing } from "@/services/pricing";
import { Hero } from "@/components/home/Hero";
import { Entertainment } from "@/components/home/Entertainment";
import { Prices } from "@/components/home/Prices";
import { BirthdayShowcase } from "@/components/home/BirthdayShowcase";
import { MembershipSection } from "@/components/home/MembershipSection";
import { Faq } from "@/components/home/Faq";
import { Contacts } from "@/components/home/Contacts";

export default async function Home() {
  const [attractions, pricing, packages, membership, faq] = await Promise.all([
    getAttractions(),
    getPricing(),
    getBirthdayPackages(),
    getMembership(),
    getFaq(),
  ]);
  const contact = getPrimaryContact();

  return (
    <>
      <Hero />
      <Entertainment attractions={attractions} />
      <Prices pricing={pricing} membership={membership} />
      <BirthdayShowcase packages={packages} contactHref={contact.href} />
      <MembershipSection membership={membership} contactHref={contact.href} />
      <Faq items={faq} />
      <Contacts />
    </>
  );
}
