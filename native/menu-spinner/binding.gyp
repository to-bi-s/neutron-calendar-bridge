{
  "targets": [
    {
      "target_name": "menu_spinner",
      "include_dirs": ["<!(node -p \"require('node-addon-api').include_dir\")"],
      "defines": ["NAPI_VERSION=8", "NAPI_DISABLE_CPP_EXCEPTIONS", "NODE_ADDON_API_DISABLE_DEPRECATED"],
      "conditions": [
        [
          "OS=='mac'",
          {
            "sources": ["src/menu_spinner.mm"],
            "xcode_settings": {
              "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
              "CLANG_ENABLE_OBJC_ARC": "YES",
              "MACOSX_DEPLOYMENT_TARGET": "11.0",
              "OTHER_LDFLAGS": ["-framework", "Cocoa"]
            }
          },
          {
            "sources": ["src/stub.cc"]
          }
        ]
      ]
    }
  ]
}
