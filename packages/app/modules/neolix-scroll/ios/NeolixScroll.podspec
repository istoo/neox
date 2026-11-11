Pod::Spec.new do |s|
  s.name           = 'NeolixScroll'
  s.version        = '0.1.0'
  s.summary        = 'Scroll view corrections for Neox'
  s.description    = 'Scroll view corrections for Neox'
  s.license        = 'Apache-2.0'
  s.author         = 'Neox'
  s.homepage       = 'https://github.com/istoo/neox'
  s.platforms      = { :ios => '15.1' }
  s.source         = { :path => '.' }
  s.static_framework = true

  s.source_files = "**/*.{h,mm}"

  install_modules_dependencies(s)
end
