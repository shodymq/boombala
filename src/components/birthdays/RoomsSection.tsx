import { Container } from "@/components/ui/Container";
import { Reveal } from "@/components/ui/Reveal";
import { getBirthdayRooms } from "@/services/rooms";
import { ROOM_PHOTO_NOTE } from "@/data/birthdayRooms";
import { RoomsGallery } from "./RoomsGallery";

/** "Выберите комнату для праздника": covers only; photos open in a dialog. */
export async function RoomsSection() {
  const rooms = await getBirthdayRooms();
  if (rooms.length === 0) return null;
  return (
    <section id="rooms" aria-labelledby="rooms-title" className="scroll-mt-20 py-12 md:py-20">
      <Container>
        <Reveal>
          <p className="mb-3 inline-flex items-center gap-2 font-display text-sm font-extrabold uppercase tracking-[0.14em] text-grape-600">
            <span aria-hidden="true" className="h-[3px] w-6 rounded-full bg-sun-400" />
            Комнаты
          </p>
          <h2
            id="rooms-title"
            className="font-display text-[2rem] font-black leading-[1.03] tracking-tighter text-grape-800 sm:text-5xl lg:text-6xl"
          >
            Выберите комнату для праздника
          </h2>
          <p className="mt-3 max-w-[48ch] text-base leading-relaxed text-muted md:mt-4 md:text-lg">
            Четыре тематические комнаты — выберите атмосферу, которая понравится имениннику.
          </p>
        </Reveal>
        <div className="mt-7 md:mt-10">
          <RoomsGallery rooms={rooms} />
          <p className="mt-5 text-sm text-muted">{ROOM_PHOTO_NOTE}</p>
        </div>
      </Container>
    </section>
  );
}
