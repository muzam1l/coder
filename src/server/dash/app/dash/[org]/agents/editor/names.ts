// Two friendly words, the way sign-up forms suggest handles.
const WORDS = [
  [
    'Brisk',
    'Calm',
    'Clever',
    'Keen',
    'Nimble',
    'Quiet',
    'Steady',
    'Swift',
    'Tidy',
    'Bright',
    'Patient',
    'Lucky',
  ],
  [
    'Heron',
    'Otter',
    'Falcon',
    'Lynx',
    'Badger',
    'Relay',
    'Beacon',
    'Compass',
    'Lantern',
    'Pilot',
    'Sparrow',
    'Harbor',
  ],
] as const;

const pick = (list: readonly string[]) => list[Math.floor(Math.random() * list.length)]!;

export const suggestName = () => `${pick(WORDS[0])} ${pick(WORDS[1])}`;
