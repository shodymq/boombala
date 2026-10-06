import Image from "next/image";
import { Plus } from "@phosphor-icons/react/dist/ssr";
import type { FaqItem } from "@/types";
import { Container } from "@/components/ui/Container";
import { Reveal } from "@/components/ui/Reveal";
import { SectionHeading } from "@/components/ui/SectionHeading";

export function Faq({ items }: { items: FaqItem[] }) {
  return (
    <section id="faq" aria-labelledby="faq-title" className="relative overflow-hidden bg-grape-50 pt-14 md:pt-28 lg:pb-0">
      <Container className="grid gap-6 pb-14 md:gap-10 md:pb-20 lg:grid-cols-12 lg:gap-16 lg:pb-28">
        <Reveal className="relative lg:col-span-4">
          <SectionHeading eyebrow="FAQ" title={<span id="faq-title">Частые вопросы</span>}>
            Ответы по ценам и условиям.
          </SectionHeading>

          {/* Boom looks at the questions */}
          <div aria-hidden="true" className="relative mt-10 hidden h-64 lg:block">
            <Image
              src="/boom/wow.webp"
              alt=""
              width={1086}
              height={1448}
              sizes="260px"
              className="absolute -bottom-6 left-4 h-72 w-auto drop-shadow-[0_14px_16px_rgba(41,13,92,0.25)]"
            />
          </div>
        </Reveal>

        <Reveal className="lg:col-span-8" delay={0.06}>
          <div className="divide-y divide-grape-200 border-y-2 border-grape-800">
            {items.map((item, i) => (
              <details key={item.id} className="group">
                <summary className="flex min-h-[4.25rem] cursor-pointer md:min-h-[4.75rem] items-center gap-4 py-4 md:gap-6">
                  <span aria-hidden="true" className="w-8 shrink-0 font-display text-base font-black text-grape-500 md:w-10 md:text-lg">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <span className="flex-1 font-display text-lg font-extrabold text-grape-800 decoration-sun-400 decoration-4 underline-offset-[6px] group-hover:underline md:text-xl">
                    {item.question}
                  </span>
                  <span
                    aria-hidden="true"
                    className="faq-plus flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-sun-400 text-grape-900 transition-transform duration-200"
                  >
                    <Plus size={18} weight="bold" />
                  </span>
                </summary>
                <p className="max-w-[62ch] pb-6 pl-12 text-base leading-relaxed text-muted md:pl-16 md:text-lg">{item.answer}</p>
              </details>
            ))}
          </div>
        </Reveal>
      </Container>
    </section>
  );
}
