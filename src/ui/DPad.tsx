import React, { ReactNode, useEffect, useRef, useState } from 'react';
import { Animated, PanResponder, Pressable, StyleProp, StyleSheet, Text, View, ViewStyle } from 'react-native';
import * as Haptics from 'expo-haptics';
import { Ionicons } from '@expo/vector-icons';
import { colors } from './theme';
import { HoldCmd, createHoldGesture, createRepeatGesture } from './holdGesture';
import { Direction, createJoystick } from './joystick';

export type Dir = 'up' | 'down' | 'left' | 'right' | 'ok';

const SIZE = 248;
const OK_SIZE = 92;
/** How long a finger must stay down before it counts as a hold (like the physical remote). */
const HOLD_AFTER_MS = 400;
/** How far the OK knob follows the finger before it stops (visual only). */
const MAX_TRAVEL = 46;

/**
 * D-pad.
 *  - Arrows: tap = one step; hold = repeat every ~130 ms.
 *  - OK: tap = OK; hold still = real press-and-hold (tile options); DRAG it like a joystick
 *    = move in that direction, repeating while held out (see joystick.ts).
 * `onDragActive` reports when a drag is in progress so the screen can stop scrolling meanwhile.
 */
export function DPad({
  onKey,
  onDragActive,
}: {
  onKey: (d: Dir, cmd: HoldCmd) => void;
  onDragActive?: (active: boolean) => void;
}) {
  const [dragDir, setDragDir] = useState<Direction | null>(null);
  const arrow = (d: Exclude<Dir, 'ok'>, icon: keyof typeof Ionicons.glyphMap, pos: object) => (
    <DPadButton
      dir={d}
      onKey={onKey}
      style={[styles.arrow, pos, dragDir === d && styles.arrowPressed]}
      pressedStyle={styles.arrowPressed}
    >
      <Ionicons name={icon} size={34} color={dragDir === d ? colors.accent : colors.text} />
    </DPadButton>
  );

  return (
    <View style={styles.ring}>
      {arrow('up', 'chevron-up', styles.top)}
      {arrow('down', 'chevron-down', styles.bottom)}
      {arrow('left', 'chevron-back', styles.left)}
      {arrow('right', 'chevron-forward', styles.right)}
      <DragOk onKey={onKey} onDragActive={onDragActive} onDirection={setDragDir} />
    </View>
  );
}

/** The OK button, draggable like a small joystick. */
function DragOk(props: {
  onKey: (d: Dir, cmd: HoldCmd) => void;
  onDragActive?: (active: boolean) => void;
  onDirection: (d: Direction | null) => void;
}) {
  const latest = useRef(props);
  latest.current = props;
  const [pressed, setPressed] = useState(false);
  const pos = useRef(new Animated.ValueXY({ x: 0, y: 0 })).current;

  const okGesture = useRef(createHoldGesture({ send: (cmd) => latest.current.onKey('ok', cmd) })).current;
  const stick = useRef(
    createJoystick({
      ok: okGesture,
      holdAfterMs: HOLD_AFTER_MS,
      onOkHoldStart: () => {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy).catch(() => {});
      },
      onDirection: (d, repeat) => {
        if (repeat) Haptics.selectionAsync().catch(() => {});
        else Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
        latest.current.onKey(d, 'Click');
      },
    }),
  ).current;

  const settle = () => {
    Animated.spring(pos, { toValue: { x: 0, y: 0 }, useNativeDriver: false, friction: 6, tension: 120 }).start();
    setPressed(false);
    latest.current.onDirection(null);
    latest.current.onDragActive?.(false);
  };

  const responder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      // Keep the gesture: the pager/ScrollView must not take a sideways drag away from OK.
      onPanResponderTerminationRequest: () => false,
      onShouldBlockNativeResponder: () => true,
      onPanResponderGrant: () => {
        stick.start();
        setPressed(true);
        latest.current.onDragActive?.(true);
      },
      onPanResponderMove: (_e, g) => {
        stick.move(g.dx, g.dy);
        const dist = Math.hypot(g.dx, g.dy);
        const k = dist > MAX_TRAVEL ? MAX_TRAVEL / dist : 1;
        pos.setValue({ x: g.dx * k, y: g.dy * k });
        latest.current.onDirection(stick.direction);
      },
      onPanResponderRelease: () => {
        if (stick.mode === 'pending') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
        stick.end();
        settle();
      },
      onPanResponderTerminate: () => {
        stick.cancel();
        settle();
      },
    }),
  ).current;

  // Never leave OK held or a direction repeating if the screen goes away mid-gesture.
  useEffect(() => () => stick.cancel(), [stick]);

  return (
    <Animated.View
      {...responder.panHandlers}
      accessible
      accessibilityRole="button"
      accessibilityLabel="OK"
      accessibilityHint="Tap for OK, hold for options, or drag in a direction to move"
      accessibilityActions={[{ name: 'activate' }]}
      onAccessibilityAction={() => okGesture.tap()}
      style={[styles.ok, pressed && styles.okPressed, { transform: pos.getTranslateTransform() }]}
    >
      <Text style={styles.okText}>OK</Text>
    </Animated.View>
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
  const gesture = useRef(
    dir === 'ok'
      ? createHoldGesture({ send: (cmd) => onKeyRef.current(dir, cmd) })
      : createRepeatGesture({
          send: (cmd) => {
            Haptics.selectionAsync().catch(() => {});
            onKeyRef.current(dir, cmd);
          },
        }),
  ).current;
  // Never leave a key held down on the TV if the screen goes away mid-hold.
  useEffect(() => () => gesture.end(), [gesture]);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={dir === 'ok' ? 'OK' : dir}
      accessibilityHint={dir === 'ok' ? 'Hold for a long press, like the TV remote' : 'Hold to keep moving'}
      onPress={() => {
        Haptics.impactAsync(dir === 'ok' ? Haptics.ImpactFeedbackStyle.Medium : Haptics.ImpactFeedbackStyle.Light).catch(() => {});
        gesture.tap();
      }}
      onLongPress={() => {
        if (dir === 'ok') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy).catch(() => {});
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
