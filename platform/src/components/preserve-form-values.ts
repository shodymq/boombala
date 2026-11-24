type FormControl = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

export type FormValueSnapshot = Array<{
  name: string;
  value: string;
  checked: boolean | null;
}>;

function controls(form: HTMLFormElement): FormControl[] {
  return Array.from(form.elements).filter((element): element is FormControl =>
    element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement,
  );
}

/** Keep unsaved values in the browser while a server action returns an inline validation/conflict result. */
export function snapshotFormValues(form: HTMLFormElement): FormValueSnapshot {
  return controls(form).map((control) => ({
    name: control.name,
    value: control.value,
    checked: control instanceof HTMLInputElement && ["checkbox", "radio"].includes(control.type) ? control.checked : null,
  }));
}

export function restoreFormValues(form: HTMLFormElement, snapshot: FormValueSnapshot): void {
  const current = controls(form);
  snapshot.forEach((saved, index) => {
    const control = current[index];
    if (!control || control.name !== saved.name) return;
    if (saved.checked !== null && control instanceof HTMLInputElement) control.checked = saved.checked;
    else if (!(control instanceof HTMLInputElement && control.type === "file")) control.value = saved.value;
  });
}
