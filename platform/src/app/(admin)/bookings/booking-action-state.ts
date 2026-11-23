export type BookingFormState = { errorCode: string; requestId?: string } | null;
export type BookingFormAction = (state: BookingFormState, formData: FormData) => Promise<BookingFormState>;
