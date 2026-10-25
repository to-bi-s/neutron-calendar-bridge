// Not macOS: the module exists (so the app's require() works) but does nothing.
#include <napi.h>

namespace {

Napi::Value Nothing(const Napi::CallbackInfo& info) { return info.Env().Undefined(); }
Napi::Value False(const Napi::CallbackInfo& info) { return Napi::Boolean::New(info.Env(), false); }

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("setFrames", Napi::Function::New(env, Nothing));
  exports.Set("setSpinning", Napi::Function::New(env, Nothing));
  exports.Set("updateItem", Napi::Function::New(env, Nothing));
  exports.Set("setKeepOpen", Napi::Function::New(env, Nothing));
  exports.Set("isTracking", Napi::Function::New(env, False));
  exports.Set("supported", Napi::Boolean::New(env, false));
  return exports;
}

}  // namespace

NODE_API_MODULE(menu_spinner, Init)
