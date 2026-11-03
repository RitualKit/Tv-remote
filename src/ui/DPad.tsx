import React, { ReactNode, useEffect, useRef } from 'react';
import { Pressable, StyleProp, StyleSheet, Text, View, ViewStyle } from 'react-native';
import * as Haptics from 'expo-haptics';
import { Ionicons } from '@expo/vector-icons';
import { colors } from './theme';
import { HoldCmd, createHoldGesture } from './holdGesture';

export type Dir = 'up' | 'down' | 'left' | 'right' | 'ok';

const SIZE = 248;
const OK_SIZE = 92;
/** How long a finger must stay down before it counts as a hold (like the physical remote). */
const HOLD_AFTER_MS = 450;

/**
 * D-pad. Tap = one click. Hold = real press-and-hold on the TV (Press … Release), so holding
 * OK on an app tile opens its options (Move / Remove) and holding an arrow scrolls.
 */
export function DPad({ onKey }: { onKey: (d: Dir, cmd: HoldCmd) => void }) {
  const arrow = (d: Exclude<Dir, 'ok'>, icon: keyof typeof Ionicons.glyphMap, pos: object) => (
    <DPadButton dir={d} onKey={onKey} style={[styles.arrow, pos]} pressedStyle={styles.arrowPressed}>
      <Ionicons name={icon} size={34} color={colors.text} />
    </DPadButton>
  );

  return (
    <View style={styles.ring}>
      {arrow('up', 'chevron-up', styles.top)}
      {arrow('down', 'chevron-down', styles.bottom)}
      {arrow('left', 'chevron-back', styles.left)}
      {arrow('right', 'chevron-forward', styles.right)}
      <DPadButton dir="ok" onKey={onKey} style={styles.ok} pressedStyle={styles.okPressed}>
        <Text style={styles.okText}>OK</Text>
      </DPadButton>
    </View>
  );
}

function DPadButton(props: {
  dir: Dir;
  onKey: (d: Dir, cmd: HoldCmd) => void;
  style: StyleProp<ViewStyle>;
  pressedStyle: StyleProp<ViewStyle>;
  children: ReactNode;
}) {
  const { dir } = props;
  const onKeyRef = useRef(props.onKey);
  onKeyRef.current = props.onKey;
  const gesture = useRef(createHoldGesture({ send: (cmd) => onKeyRef.current(dir, cmd) })).current;
  // Never leave a key held down on the TV if the screen goes away mid-hold.
  useEffect(() => () => gesture.end(), [gesture]);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={dir === 'ok' ? 'OK' : dir}
      accessibilityHint="Hold for a long press, like the TV remote"
      onPress={() => {
        Haptics.impactAsync(dir === 'ok' ? Haptics.ImpactFeedbackStyle.Medium : Haptics.ImpactFeedbackStyle.Light).catch(() => {});
        gesture.tap();
      }}
      onLongPress={() => {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy).catch(() => {});
        gesture.holdStart();
      }}
      onPressOut={() => gesture.end()}
      delayLongPress={HOLD_AFTER_MS}
      hitSlop={4}
      style={({ pressed }) => [props.style, pressed && props.pressedStyle]}
    >
      {props.children}
    </Pressable>
  );
}

const ARROW = (SIZE - OK_SIZE) / 2;

const styles = StyleSheet.create({
  ring: {
    width: SIZE,
    height: SIZE,
    borderRadius: SIZE / 2,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    alignSelf: 'center',
  },
  arrow: {
    position: 'absolute',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: ARROW / 2,
  },
  arrowPressed: { backgroundColor: colors.buttonPressed },
  top: { top: 0, left: ARROW, width: OK_SIZE, height: ARROW },
  bottom: { bottom: 0, left: ARROW, width: OK_SIZE, height: ARROW },
  left: { left: 0, top: ARROW, width: ARROW, height: OK_SIZE },
  right: { right: 0, top: ARROW, width: ARROW, height: OK_SIZE },
  ok: {
    position: 'absolute',
    top: ARROW,
    left: ARROW,
    width: OK_SIZE,
    height: OK_SIZE,
    borderRadius: OK_SIZE / 2,
    backgroundColor: colors.button,
    borderWidth: 2,
    borderColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  okPressed: { backgroundColor: colors.accent },
  okText: { color: colors.text, fontSize: 20, fontWeight: '700' },
});
