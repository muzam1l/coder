'use client';

import { useEffect, useState } from 'preact/hooks';

import { NOTIFY } from '@/comps/frame/task-toasts';

/** Browser notifications for watched tasks, off until asked for; the permission prompt shows once. */
export function NotifySwitch() {
  const [on, setOn] = useState(false);
  const [blocked, setBlocked] = useState(false);

  useEffect(() => {
    if (typeof Notification === 'undefined') return setBlocked(true);
    setBlocked(Notification.permission === 'denied');
    setOn(localStorage.getItem(NOTIFY) === '1' && Notification.permission === 'granted');
  }, []);

  const toggle = async (input: HTMLInputElement) => {
    if (input.checked && Notification.permission === 'default')
      await Notification.requestPermission();
    const next = input.checked && Notification.permission === 'granted';
    if (next) localStorage.setItem(NOTIFY, '1');
    else localStorage.removeItem(NOTIFY);
    input.checked = next;
    setOn(next);
    setBlocked(Notification.permission === 'denied');
  };

  return (
    <label class="notify">
      <input
        type="checkbox"
        role="switch"
        class="switch"
        checked={on}
        disabled={blocked}
        onChange={event => void toggle(event.currentTarget)}
      />
      {blocked ? 'Notifications are blocked in this browser' : 'Notify me when a task finishes'}
    </label>
  );
}
