import { useEffect, useState } from 'react';

// Matches Tailwind's `max-sm` breakpoint used for the phone-specific styles.
export const PHONE_QUERY = '(max-width: 639.98px)';

/** True on phone-sized viewports, where the editor uses its single-section layout. */
export function usePhoneLayout(): boolean {
  const [isPhone, setIsPhone] = useState(
    () => typeof window !== 'undefined' && !!window.matchMedia?.(PHONE_QUERY).matches,
  );

  useEffect(() => {
    const query = window.matchMedia?.(PHONE_QUERY);
    if (!query) return;
    const update = () => setIsPhone(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  return isPhone;
}
