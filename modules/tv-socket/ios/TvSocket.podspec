Pod::Spec.new do |s|
  s.name           = 'TvSocket'
  s.version        = '1.0.0'
  s.summary        = 'WebSocket for Samsung TV port 8002 (self-signed TLS, private LAN only)'
  s.description    = 'Local Expo module used by Frame Remote to talk to a Samsung The Frame over wss://<lan-ip>:8002.'
  s.license        = 'MIT'
  s.author         = 'Frame Remote'
  s.homepage       = 'https://github.com/RitualKit/Tv-remote'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = '**/*.{h,m,swift}'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES'
  }
end
