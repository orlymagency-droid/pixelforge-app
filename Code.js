/**
 * theme.js — Elite Dark Design System
 * Full Black + Neon Blue aesthetic
 */

export const COLORS = {
  // Base
  black:      '#000000',
  background: '#000000',
  surface:    '#0A0A14',
  surfaceAlt: '#0D0D1E',
  border:     '#1A1A2E',

  // Neon palette
  neonBlue:   '#00D1FF',
  neonPurple: '#7B2FFF',
  neonPink:   '#FF2F7B',
  neonGreen:  '#00FF88',

  // Text
  textPrimary:   '#FFFFFF',
  textSecondary: '#8888AA',
  textMuted:     '#444455',

  // Semantic
  success: '#00FF88',
  error:   '#FF4444',
  warning: '#FFB800',
};

export const FONTS = {
  regular: 'Inter-Regular',
  medium:  'Inter-Medium',
  bold:    'Inter-Bold',
  black:   'Inter-Black',
  mono:    'JetBrainsMono-Regular',
};

export const SHADOWS = {
  neonBlue: {
    shadowColor:   '#00D1FF',
    shadowOffset:  { width: 0, height: 0 },
    shadowOpacity: 0.6,
    shadowRadius:  20,
    elevation:     20,
  },
  neonPurple: {
    shadowColor:   '#7B2FFF',
    shadowOffset:  { width: 0, height: 0 },
    shadowOpacity: 0.6,
    shadowRadius:  20,
    elevation:     20,
  },
};

export const SPACING = {
  xs:  4,
  sm:  8,
  md:  16,
  lg:  24,
  xl:  32,
  xxl: 48,
};

export const BORDER_RADIUS = {
  sm:  8,
  md:  12,
  lg:  16,
  xl:  24,
  full: 9999,
};