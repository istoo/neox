Pod::Spec.new do |s|
  s.name = 'NeolixWindowLayout'
  s.version = '0.1.0'
  s.summary = 'System window layout geometry for Neox'
  s.description = 'Publishes system bar and division geometry'
  s.license = 'Apache-2.0'
  s.author = 'Neox'
  s.homepage = 'https://github.com/istoo/neox'
  s.platforms = { :ios => '16.4' }
  s.swift_version = '5.4'
  s.source = { :path => '.' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '**/*.swift'
end
