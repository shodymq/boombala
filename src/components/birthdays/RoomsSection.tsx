import type { Locale } from "@/types/birthdays-v4";
import { Container } from "@/components/ui/Container";
import { Reveal } from "@/components/ui/Reveal";
import { getBirthdayRooms } from "@/services/rooms";
import { BIRTHDAYS_UI } from "@/data/birthdays-ui";
import { RoomsGallery } from "./RoomsGallery";

/** The four themed rooms: covers only; photos open in a dialog. The room list is the same in both languages (the names are brand names). */
export async function RoomsSection({ locale }: { locale: Locale }) {
  const rooms = await getBirthdayRooms();
  if (rooms.length === 0) return null;
  const ui = BIRTHDAYS_UI[locale];
  return (
    <section id="rooms" aria-labelledby="rooms-title" className="scroll-mt-20 py-12 md:py-20">
      <Container>
        <Reveal>
          <p className="mb-3 inline-flex items-center gap-2 font-display text-sm font-extrabold uppercase tracking-[0.14em] text-grape-600">
            <span aria-hidden="true" className="h-[3px] w-6 rounded-full bg-sun-400" />
            {ui.roomsEyebrow}
          </p>
          <h2 id="rooms-title" className="font-display text-[2rem] font-black leading-[1.03] tracking-tighter text-grape-800 sm:text-5xl lg:text-6xl">
            {ui.roomsTitle}
          </h2>
          <p className="mt-3 max-w-[48ch] text-base leading-relaxed text-muted md:mt-4 md:text-lg">{ui.roomsLead}</p>
        </Reveal>
        <div className="mt-7 md:mt-10">
          <RoomsGallery rooms={rooms} locale={locale} />
          <p className="mt-5 text-sm text-muted">{ui.roomsNote}</p>
        </div>
      </Container>
    </section>
  );
}
