export interface SubtitleStyle {
  preset?: string;
  name?: string;
  font: string;
  weight: number;
  italic?: boolean;
  size: number;
  tracking?: number;
  leading?: number;
  color: string;
  stroke?: string;
  strokeWidth?: number;
  bg?: string;
  bgOpacity?: number;
  bgRadius?: number;
  bgPadX?: number;
  bgPadY?: number;
  position: 'top' | 'center' | 'bottom';
  offsetY: number;
  align: 'left' | 'center' | 'right';
  animation?: 'none' | 'fade' | 'pop' | 'bounce' | 'typewriter' | 'wipe' | 'karaoke';
  highlightColor?: string;
  shadow?: 'soft' | 'hard' | 'none';
  uppercase?: boolean;
  maxLineChars?: number;
}

export const DEFAULT_STYLE: SubtitleStyle = {
  preset: 'clean-bottom',
  name: '底部白字',
  font: 'Inter',
  weight: 700,
  italic: false,
  size: 0.048,
  tracking: 0.0,
  leading: 1.25,
  color: '#FFFFFF',
  stroke: '',
  strokeWidth: 0,
  bg: '#000000',
  bgOpacity: 0.55,
  bgRadius: 0.3,
  bgPadX: 0.6,
  bgPadY: 0.3,
  position: 'bottom',
  offsetY: 0.1,
  align: 'center',
  animation: 'fade',
  shadow: 'soft',
  uppercase: false,
  maxLineChars: 36
};

export interface StylePreset {
  slug: string;
  name: string;
  style: SubtitleStyle;
}

export const STYLE_PRESETS: StylePreset[] = [
  {
    slug: 'clean-bottom',
    name: '底部白字',
    style: { ...DEFAULT_STYLE }
  },
  {
    slug: 'tiktok-neon',
    name: '霓虹描边',
    style: {
      preset: 'tiktok-neon',
      name: '霓虹描边',
      font: 'Inter',
      weight: 800,
      italic: false,
      size: 0.058,
      tracking: 0,
      leading: 1.2,
      color: '#00FFFF',
      stroke: '#000000',
      strokeWidth: 0.08,
      bg: '',
      bgOpacity: 0,
      position: 'bottom',
      offsetY: 0.12,
      align: 'center',
      animation: 'pop',
      shadow: 'soft',
      uppercase: true,
      maxLineChars: 28
    }
  },
  {
    slug: 'bold-white',
    name: '大字描边',
    style: {
      preset: 'bold-white',
      name: '大字描边',
      font: 'Inter',
      weight: 900,
      italic: false,
      size: 0.072,
      tracking: -0.015,
      leading: 1.1,
      color: '#FFFFFF',
      stroke: '#000000',
      strokeWidth: 0.09,
      bg: '',
      bgOpacity: 0,
      position: 'center',
      offsetY: 0,
      align: 'center',
      animation: 'pop',
      shadow: 'hard',
      uppercase: true,
      maxLineChars: 22
    }
  },
  {
    slug: 'karaoke',
    name: '逐词高亮',
    style: {
      preset: 'karaoke',
      name: '逐词高亮',
      font: 'Inter',
      weight: 800,
      italic: false,
      size: 0.065,
      tracking: -0.01,
      leading: 1.15,
      color: '#FFFFFF',
      highlightColor: '#FFE500',
      stroke: '#000000',
      strokeWidth: 0.07,
      bg: '',
      bgOpacity: 0,
      position: 'center',
      offsetY: 0.05,
      align: 'center',
      animation: 'karaoke',
      shadow: 'hard',
      uppercase: true,
      maxLineChars: 22
    }
  },
  {
    slug: 'cinema',
    name: '电影字幕',
    style: {
      preset: 'cinema',
      name: '电影字幕',
      font: 'Inter',
      weight: 500,
      italic: false,
      size: 0.04,
      tracking: 0.02,
      leading: 1.35,
      color: '#F8FAFC',
      stroke: '',
      strokeWidth: 0,
      bg: '',
      bgOpacity: 0,
      position: 'bottom',
      offsetY: 0.06,
      align: 'center',
      animation: 'fade',
      shadow: 'hard',
      uppercase: false,
      maxLineChars: 42
    }
  }
];

export function presetBySlug(slug: string): SubtitleStyle | null {
  const found = STYLE_PRESETS.find((p) => p.slug === slug);
  return found ? { ...found.style } : null;
}
