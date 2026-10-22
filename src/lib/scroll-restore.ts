/**
 * Remember where the page is scrolled and return a function that puts it back. iOS Safari can move the page behind an open modal
 * when a field inside it gets focus (measured in the iOS 26 Simulator: 1400 -> 1234 px); without this the visitor would land
 * somewhere else after closing. `instant` overrides the site's smooth scrolling.
 */
export function rememberScroll(): () => void {
  const y = window.scrollY;
  return () => {
    requestAnimationFrame(() => {
      if (Math.abs(window.scrollY - y) > 1) window.scrollTo({ top: y, behavior: "instant" });
    });
  };
}
