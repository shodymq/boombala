"use client";

import Image from "next/image";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight, CaretLeft, CaretRight, Play, X } from "@phosphor-icons/react";
import type { BirthdayRoom } from "@/types";
import { useLeadForm } from "@/components/lead/LeadFormProvider";
import { useSelectedPackage } from "@/components/lead/SelectedPackage";
import { buttonClass } from "@/components/ui/buttonStyles";

/** Cover grid + a native <dialog> viewer. Nothing is loaded for a room until its dialog is opened. */
export function RoomsGallery({ rooms }: { rooms: BirthdayRoom[] }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const pendingLead = useRef<string | null>(null);
  const { open: openLead } = useLeadForm();
  const { selected: selectedPackage } = useSelectedPackage();
  const [roomId, setRoomId] = useState<string | null>(null);
  const [index, setIndex] = useState(0);
  const [videoOn, setVideoOn] = useState(false);

  const room = rooms.find((r) => r.id === roomId) ?? null;

  const openRoom = (id: string) => {
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setRoomId(id);
    setIndex(0);
    setVideoOn(false);
  };

  // Open the native dialog after the room is rendered into it.
  useEffect(() => {
    const d = dialogRef.current;
    if (room && d && !d.open) d.showModal();
  }, [room]);

  // Scroll lock follows state, so it is always released.
  useEffect(() => {
    if (!room) return;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = "";
    };
  }, [room]);

  const finish = useCallback(() => {
    setRoomId(null);
    setVideoOn(false);
    returnFocus.current?.focus?.();
    // The booking form opens only after this dialog is gone (no stacked modals).
    const room = pendingLead.current;
    pendingLead.current = null;
    if (room) window.setTimeout(() => openLead({ room, package: selectedPackage ?? undefined, source: "room-gallery" }), 0);
  }, [openLead, selectedPackage]);

  const close = useCallback(() => {
    const d = dialogRef.current;
    if (d?.open) d.close();
    finish();
  }, [finish]);

  // Escape closes the native dialog without going through close().
  useEffect(() => {
    const d = dialogRef.current;
    if (!d) return;
    const onClose = () => {
      if (!d.open) finish();
    };
    d.addEventListener("close", onClose);
    return () => d.removeEventListener("close", onClose);
  }, [finish]);

  const step = (dir: 1 | -1) => {
    if (!room) return;
    setIndex((i) => (i + dir + room.images.length) % room.images.length);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowRight") step(1);
    else if (e.key === "ArrowLeft") step(-1);
  };

  const askToBook = () => {
    if (!room) return;
    pendingLead.current = room.id;
    close();
  };

  const photo = room?.images[index] ?? room?.images[0];

  return (
    <>
      <ul className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4 lg:gap-5">
        {rooms.map((r, i) => (
          <li key={r.id}>
            <button
              type="button"
              onClick={() => openRoom(r.id)}
              aria-haspopup="dialog"
              className="group block w-full text-left"
            >
              <span
                className={`relative block overflow-hidden bg-grape-900 [aspect-ratio:4/3] ${
                  i % 2 === 0
                    ? "rounded-tl-[1.75rem] rounded-br-[1.75rem] lg:rounded-tl-[2.5rem] lg:rounded-br-[2.5rem]"
                    : "rounded-tr-[1.75rem] rounded-bl-[1.75rem] lg:rounded-tr-[2.5rem] lg:rounded-bl-[2.5rem]"
                }`}
              >
                <Image
                  src={r.coverImage.src}
                  alt={r.coverImage.alt}
                  fill
                  sizes="(min-width: 1280px) 290px, (min-width: 1024px) 24vw, (min-width: 640px) 45vw, 50vw"
                  className="object-cover transition-transform duration-500 ease-out group-hover:scale-[1.04]"
                />
              </span>
              <span className="mt-3 block font-display text-lg font-black leading-tight tracking-tight text-grape-800 sm:text-xl">
                {r.name}
              </span>
              <span className="mt-0.5 inline-flex items-center gap-1.5 font-display text-sm font-extrabold text-grape-600 underline decoration-sun-400 decoration-2 underline-offset-4">
                Посмотреть комнату
                <ArrowRight size={14} weight="bold" aria-hidden="true" className="transition-transform group-hover:translate-x-1" />
              </span>
            </button>
          </li>
        ))}
      </ul>

      <dialog
        ref={dialogRef}
        aria-labelledby="room-dialog-title"
        onKeyDown={onKeyDown}
        onClick={(e) => {
          if (e.target === dialogRef.current) close();
        }}
        className="m-0 mt-auto max-h-[94dvh] w-full max-w-none overflow-y-auto overscroll-contain rounded-t-[2rem] bg-paper p-0 text-ink backdrop:bg-grape-900/75 sm:m-auto sm:max-h-[92dvh] sm:max-w-[56rem] sm:rounded-[2rem]"
      >
        {room && photo ? (
          <div className="p-4 pb-0 sm:p-6 sm:pb-0">
            <div className="flex items-start justify-between gap-4">
              <h3 id="room-dialog-title" className="font-display text-[1.625rem] font-black leading-tight tracking-tight text-grape-800 sm:text-4xl">
                {room.name}
              </h3>
              <button
                type="button"
                onClick={close}
                aria-label="Закрыть"
                className="group -mr-2 -mt-2 flex h-11 w-11 shrink-0 items-center justify-center"
              >
                <span className="flex h-8 w-8 items-center justify-center rounded-full bg-grape-100 text-grape-800 transition-colors group-hover:bg-grape-200">
                  <X size={16} weight="bold" aria-hidden="true" />
                </span>
              </button>
            </div>

            <div
              className="relative mx-auto mt-3 w-full overflow-hidden rounded-2xl bg-grape-900"
              style={{
                aspectRatio: `${photo.width} / ${photo.height}`,
                // Keep the whole photo (no cropping) and never taller than the viewport allows.
                maxWidth: `calc(60dvh * ${photo.width / photo.height})`,
              }}
            >
              <Image
                key={photo.src}
                src={photo.src}
                alt={photo.alt}
                fill
                priority
                sizes="(min-width: 640px) 52rem, 100vw"
                className="object-cover"
              />
              {room.images.length > 1 ? (
                <>
                  <button
                    type="button"
                    onClick={() => step(-1)}
                    aria-label="Предыдущее фото"
                    className="absolute left-2 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-paper text-grape-800 shadow-soft transition-transform active:scale-95"
                  >
                    <CaretLeft size={20} weight="bold" aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    onClick={() => step(1)}
                    aria-label="Следующее фото"
                    className="absolute right-2 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-paper text-grape-800 shadow-soft transition-transform active:scale-95"
                  >
                    <CaretRight size={20} weight="bold" aria-hidden="true" />
                  </button>
                  <p className="absolute bottom-2 right-2 rounded-full bg-grape-900/80 px-3 py-1 text-xs font-bold text-white" aria-live="polite">
                    {index + 1} / {room.images.length}
                  </p>
                </>
              ) : null}
            </div>

            {room.images.length > 1 ? (
              <ul className="mt-2 flex gap-2" aria-label="Фотографии комнаты">
                {room.images.map((p, i) => (
                  <li key={p.src}>
                    <button
                      type="button"
                      onClick={() => setIndex(i)}
                      aria-label={`Фото ${i + 1} из ${room.images.length}`}
                      aria-current={i === index ? "true" : undefined}
                      className={`relative block h-14 w-[5.5rem] overflow-hidden rounded-xl border-2 transition-colors ${
                        i === index ? "border-grape-700" : "border-transparent opacity-80 hover:opacity-100"
                      }`}
                    >
                      <Image src={p.src} alt="" fill sizes="88px" className="object-cover" />
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}

            {/* Video: rendered only when a real clip exists. Loaded on demand, never autoplayed. */}
            {room.video ? (
              <div className="relative mt-3 overflow-hidden rounded-2xl bg-grape-900 [aspect-ratio:16/9]">
                {videoOn ? (
                  <video
                    src={room.video}
                    poster={room.videoPoster?.src}
                    controls
                    playsInline
                    preload="metadata"
                    autoPlay
                    className="h-full w-full"
                  />
                ) : (
                  <button
                    type="button"
                    onClick={() => setVideoOn(true)}
                    aria-label={`Смотреть видео: ${room.name}`}
                    className="group absolute inset-0 flex items-center justify-center"
                  >
                    {room.videoPoster ? (
                      <Image src={room.videoPoster.src} alt="" fill sizes="(min-width: 640px) 52rem, 100vw" className="object-cover" />
                    ) : null}
                    <span className="relative flex h-16 w-16 items-center justify-center rounded-full bg-sun-400 text-grape-900 shadow-[0_5px_0_0_#b98600] transition-transform group-active:translate-y-[3px]">
                      <Play size={26} weight="fill" aria-hidden="true" />
                    </span>
                  </button>
                )}
              </div>
            ) : null}

            <div className="sticky bottom-0 -mx-4 mt-4 bg-paper px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3 shadow-[0_-10px_14px_-12px_rgb(41_13_92/0.25)] sm:-mx-6 sm:px-6">
              <button type="button" onClick={askToBook} className={buttonClass("primary", "w-full sm:w-auto")}>
                Узнать о бронировании
              </button>
              <p className="mt-2 text-[0.8125rem] leading-snug text-muted">
                Выбор комнаты не гарантирует, что она свободна на вашу дату.
              </p>
            </div>
          </div>
        ) : null}
      </dialog>
    </>
  );
}
