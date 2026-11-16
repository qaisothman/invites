import { useColorScheme } from 'react-native';

// One accent colour, system font, light and dark. Close to the iOS system
// palette so the app looks at home without a UI kit.

const light = {
  background: '#FFFFFF',
  surface: '#F2F2F7',
  border: '#D8D8DE',
  text: '#111114',
  muted: '#6C6C72',
  accent: '#2F5BEA',
  onAccent: '#FFFFFF',
  danger: '#C62828',
};

const dark: Theme = {
  background: '#000000',
  surface: '#1C1C1E',
  border: '#38383C',
  text: '#F2F2F7',
  muted: '#98989F',
  accent: '#6F8FFF',
  onAccent: '#FFFFFF',
  danger: '#FF6B6B',
};

export type Theme = typeof light;

export function useTheme(): Theme {
  return useColorScheme() === 'dark' ? dark : light;
}

export const space = { xs: 4, sm: 8, md: 16, lg: 24 };
