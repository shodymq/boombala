export function initialDepositRefundRequiresCancellation(
  leadStatus: string,
  bookingReservationState: "none" | "active" | "released",
): boolean {
  return bookingReservationState === "active" || ["booked", "confirmed", "paid"].includes(leadStatus);
}

export function canCancelStatusOnlyBooking(
  leadStatus: string,
  bookingReservationState: "none" | "active" | "released",
): boolean {
  return bookingReservationState === "none" && ["booked", "confirmed", "paid"].includes(leadStatus);
}
