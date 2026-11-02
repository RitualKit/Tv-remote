import React, { ReactNode, useEffect, useRef } from 'react';
import { Pressable, StyleProp, StyleSheet, Text, ViewStyle } from 'react-native';
import * as Haptics from 'expo-haptics';
import { colors } from './theme';

interface Props {
  label?: string;
  icon?: ReactNode;
  onPress: () => void;
  onLongPress?: () => void;
  /** Fire repeatedly while held (volume / channel). */
  repeat?: boolean;
  haptic?: 'light' | 'medium';
  style?: StyleProp<ViewStyle>;
  color?: string;
  accessibilityLabel?: string;
}

const REPEAT_DELAY_MS = 400;
const REPEAT_EVERY_MS = 150;

export function RemoteButton({
  label,
  icon,
  onPress,
  onLongPress,
  repeat,
  haptic = 'light',
  style,
  color,
  accessibilityLabel,
}: Props) {
  const timers = useRef<{ delay?: ReturnType<typeof setTimeout>; every?: ReturnType<typeof setInterval> }>({});

  const buzz = () =>
    Haptics.impactAsync(haptic === 'medium' ? Haptics.ImpactFeedbackStyle.Medium : Haptics.ImpactFeedbackStyle.Light).catch(
      () => {},
    );

  const stopRepeat = () => {
    clearTimeout(timers.current.delay);
    clearInterval(timers.current.every);
    timers.current = {};
  };
  useEffect(() => stopRepeat, []);

  const fire = () => {
    buzz();
    onPress();
  };

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      onPress={repeat ? undefined : fire}
      onPressIn={
        repeat
          ? () => {
              fire();
              timers.current.delay = setTimeout(() => {
                timers.current.every = setInterval(() => {
                  Haptics.selectionAsync().catch(() => {});
                  onPress();
                }, REPEAT_EVERY_MS);
              }, REPEAT_DELAY_MS);
            }
          : undefined
      }
      onPressOut={repeat ? stopRepeat : undefined}
      onLongPress={
        onLongPress
          ? () => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy).catch(() => {});
              onLongPress();
            }
          : undefined
      }
      delayLongPress={700}
      style={({ pressed }) => [
        styles.base,
        color ? { backgroundColor: color } : null,
        style,
        pressed && styles.pressed,
      ]}
    >
      {icon}
      {label ? (
        <Text style={[styles.label, icon ? styles.labelWithIcon : null]} numberOfLines={1} adjustsFontSizeToFit>
          {label}
        </Text>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    minHeight: 56,
    minWidth: 56,
    borderRadius: 16,
    backgroundColor: colors.button,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  pressed: { backgroundColor: colors.buttonPressed, transform: [{ scale: 0.96 }] },
  label: { color: colors.text, fontSize: 15, fontWeight: '600' },
  labelWithIcon: { fontSize: 12, marginTop: 2, color: colors.textDim },
});
