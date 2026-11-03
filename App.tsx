import React, { useEffect, useRef, useState } from 'react';
import { Alert, LayoutChangeEvent, NativeScrollEvent, NativeSyntheticEvent, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { ScrollViewInstance } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useRemote } from './src/useRemote';
import { KEYS } from './src/tv/keys';
import { RemoteButton } from './src/ui/RemoteButton';
import { DPad } from './src/ui/DPad';
import { NumberPad } from './src/ui/NumberPad';
import { StatusPill } from './src/ui/StatusPill';
import { AppGrid } from './src/ui/AppGrid';
import { SetupModal } from './src/ui/SetupModal';
import { AppsModal } from './src/ui/AppsModal';
import { colors } from './src/ui/theme';

const DPAD_KEYS = { up: KEYS.up, down: KEYS.down, left: KEYS.left, right: KEYS.right, ok: KEYS.ok } as const;

function Remote() {
  const r = useRemote();
  const [setupOpen, setSetupOpen] = useState(false);
  const [appsOpen, setAppsOpen] = useState(false);
  const [page, setPage] = useState(0);
  const [pageWidth, setPageWidth] = useState(0);
  const pagerRef = useRef<ScrollViewInstance>(null);

  const onPagerLayout = (e: LayoutChangeEvent) => setPageWidth(e.nativeEvent.layout.width);
  // Track the visible page while scrolling (not only at momentum end, which doesn't fire for
  // every kind of scroll); React skips the re-render when the page number is unchanged.
  const onPageScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    if (pageWidth > 0) setPage(Math.round(e.nativeEvent.contentOffset.x / pageWidth));
  };
  const goToPage = (p: number) => {
    pagerRef.current?.scrollTo({ x: p * pageWidth, animated: true });
    setPage(p);
  };

  // First launch: nothing configured yet → open setup.
  useEffect(() => {
    if (r.loaded && !r.settings.tvIp) setSetupOpen(true);
  }, [r.loaded, r.settings.tvIp]);

  const icon = (name: keyof typeof Ionicons.glyphMap, size = 24) => <Ionicons name={name} size={size} color={colors.text} />;

  const powerOff = () =>
    Alert.alert('Turn TV off?', 'Holds the power button for 3 s. You will need the physical remote to turn it back on.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Turn off', style: 'destructive', onPress: () => r.holdKey(KEYS.power, 3000) },
    ]);

  const showMessage = r.conn.status !== 'connected' && r.conn.message;

  return (
    <SafeAreaView style={styles.root} edges={['top', 'bottom']}>
      <StatusBar style="light" />
      <View style={styles.headerWrap}>
        <View style={styles.header}>
          <View style={{ flex: 1, gap: 8 }}>
            <Text style={styles.title}>{page === 0 ? 'The Frame' : 'Apps'}</Text>
            <StatusPill conn={r.conn} onPress={r.reconnect} />
          </View>
          <Pressable onPress={() => setSetupOpen(true)} hitSlop={12} accessibilityLabel="Settings" style={styles.gear}>
            <Ionicons name="settings-outline" size={26} color={colors.textDim} />
          </Pressable>
        </View>
        {showMessage ? <Text style={styles.message}>{r.conn.message}</Text> : null}
      </View>

      {/* Two pages side by side: swipe left for Apps, right to go back to the remote. */}
      <View style={styles.pager} onLayout={onPagerLayout}>
        {pageWidth > 0 && (
          <ScrollView
            ref={pagerRef}
            horizontal
            pagingEnabled
            showsHorizontalScrollIndicator={false}
            onScroll={onPageScroll}
            scrollEventThrottle={32}
            keyboardShouldPersistTaps="handled"
          >
            <ScrollView style={{ width: pageWidth }} contentContainerStyle={styles.content}>
              <View style={styles.row}>
                <RemoteButton
                  icon={icon('power', 26)}
                  label="Power"
                  haptic="medium"
                  color={colors.power}
                  onPress={() => r.key(KEYS.power)}
                  onLongPress={powerOff}
                  accessibilityLabel="Power. Tap toggles Art Mode and TV, hold to turn off"
                  style={styles.flex}
                />
                <RemoteButton icon={icon('image-outline', 26)} label="Art / TV" haptic="medium" onPress={r.toggleArt} style={styles.flex} />
              </View>

              <View style={styles.row}>
                <RemoteButton icon={icon('swap-horizontal')} label="Source" onPress={() => r.key(KEYS.source)} style={styles.flex} />
                <RemoteButton icon={icon('home-outline')} label="Home" onPress={() => r.key(KEYS.home)} style={styles.flex} />
                <RemoteButton icon={icon('menu')} label="Menu" onPress={() => r.key(KEYS.menu)} style={styles.flex} />
              </View>

              <DPad onKey={(d, cmd) => r.keyCmd(DPAD_KEYS[d], cmd)} />

              <View style={styles.row}>
                <RemoteButton icon={icon('arrow-undo')} label="Back" onPress={() => r.key(KEYS.back)} style={styles.flex} />
                <RemoteButton icon={icon('information-circle-outline')} label="Info" onPress={() => r.key(KEYS.info)} style={styles.flex} />
                <RemoteButton icon={icon('grid-outline')} label="Guide" onPress={() => r.key(KEYS.guide)} style={styles.flex} />
              </View>

              <View style={styles.rockers}>
                <Rocker label="VOL" onUp={() => r.key(KEYS.volUp)} onDown={() => r.key(KEYS.volDown)} upIcon="add" downIcon="remove" />
                <RemoteButton icon={icon('volume-mute', 28)} label="Mute" onPress={() => r.key(KEYS.mute)} style={styles.mute} />
                <Rocker label="CH" onUp={() => r.key(KEYS.chUp)} onDown={() => r.key(KEYS.chDown)} upIcon="chevron-up" downIcon="chevron-down" />
              </View>

              <NumberPad onKey={r.key} />
            </ScrollView>

            <ScrollView style={{ width: pageWidth }} contentContainerStyle={styles.content}>
              <AppGrid apps={r.settings.apps} onLaunch={r.launch} onEdit={() => setAppsOpen(true)} />
              <Text style={styles.hint}>Tap to open on the TV · hold or tap Edit to change the buttons</Text>
            </ScrollView>
          </ScrollView>
        )}
      </View>

      <PageDots page={page} labels={['Remote', 'Apps']} onSelect={goToPage} />

      <AppsModal
        visible={appsOpen}
        apps={r.settings.apps}
        tvIp={r.settings.tvIp}
        onClose={() => setAppsOpen(false)}
        onChange={r.setApps}
        onCheck={r.checkApp}
        tvApps={r.tvApps}
        onLoadTvApps={r.loadTvApps}
      />

      <SetupModal
        visible={setupOpen}
        settings={r.settings}
        log={r.log}
        onClose={() => setSetupOpen(false)}
        onSaveTvIp={r.saveTvIp}
        onForgetPairing={r.forgetPairing}
        onResetCertificate={r.resetCertificate}
      />
    </SafeAreaView>
  );
}

function PageDots({ page, labels, onSelect }: { page: number; labels: string[]; onSelect: (p: number) => void }) {
  return (
    <View style={styles.dots}>
      {labels.map((label, i) => (
        <Pressable
          key={label}
          onPress={() => onSelect(i)}
          hitSlop={10}
          accessibilityRole="tab"
          accessibilityLabel={label}
          accessibilityState={{ selected: page === i }}
          style={styles.dotHit}
        >
          <View style={[styles.dot, page === i && styles.dotOn]} />
        </Pressable>
      ))}
    </View>
  );
}

function Rocker(props: {
  label: string;
  onUp: () => void;
  onDown: () => void;
  upIcon: keyof typeof Ionicons.glyphMap;
  downIcon: keyof typeof Ionicons.glyphMap;
}) {
  return (
    <View style={styles.rocker}>
      <RemoteButton repeat icon={<Ionicons name={props.upIcon} size={30} color={colors.text} />} onPress={props.onUp} style={styles.rockerBtn} accessibilityLabel={`${props.label} up`} />
      <Text style={styles.rockerLabel}>{props.label}</Text>
      <RemoteButton repeat icon={<Ionicons name={props.downIcon} size={30} color={colors.text} />} onPress={props.onDown} style={styles.rockerBtn} accessibilityLabel={`${props.label} down`} />
    </View>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <Remote />
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  headerWrap: { paddingHorizontal: 20, paddingTop: 20, gap: 12 },
  pager: { flex: 1 },
  content: { padding: 20, gap: 16, paddingBottom: 24 },
  hint: { color: colors.textDim, fontSize: 13, textAlign: 'center', marginTop: 8 },
  dots: { flexDirection: 'row', justifyContent: 'center', gap: 6, paddingVertical: 8 },
  dotHit: { padding: 4 },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.border },
  dotOn: { backgroundColor: colors.text, width: 20 },
  header: { flexDirection: 'row', alignItems: 'flex-start' },
  title: { color: colors.text, fontSize: 28, fontWeight: '800' },
  gear: { padding: 6 },
  message: { color: colors.textDim, fontSize: 14, lineHeight: 20 },
  row: { flexDirection: 'row', gap: 10 },
  flex: { flex: 1, minHeight: 64 },
  rockers: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  rocker: { width: 92, backgroundColor: colors.surface, borderRadius: 24, padding: 6, alignItems: 'center', gap: 4 },
  rockerBtn: { width: 80, height: 64, borderRadius: 18 },
  rockerLabel: { color: colors.textDim, fontSize: 13, fontWeight: '700' },
  mute: { width: 88, height: 88, borderRadius: 44 },
});
