// The spinning sync symbol in the menu-bar menu (0.32.4).
//
// Electron builds the menu-bar menu as a native NSMenu and gives JavaScript no handle to it; while
// the menu is open, tray.setContextMenu() does not change what is shown. AppKit, though, tells
// everyone when a menu opens and closes (NSMenuDidBeginTrackingNotification /
// NSMenuDidEndTrackingNotification, with the NSMenu as the object), and an NSMenuItem's image and
// title can be changed while its menu is open. So this module watches for the menu-bar menu being
// opened, and while it is open swaps the image of the syncing account lines (0.37.15: all of them, in
// step) through the frames of the sync symbol on a timer (NSRunLoopCommonModes, so it runs during menu tracking), and lets
// JavaScript change an item's title and image while the menu is open (a sync that starts or ends).
//
// 0.37.12: items that keep the menu open (Refresh Now). macOS closes a menu on every click and has
// no switch against it; the one thing AppKit does not dismiss is an item with a view of its own. So
// those items get a view that draws a menu row itself — image, title, key equivalent, the system's
// selection highlight — and sends the item's action on the click without ending the tracking.
// JavaScript names the items (setKeepOpen) and the geometry (row height, insets) it should use.
//
// Everything runs on the main thread: Electron's main process JavaScript, AppKit's notifications
// and the timer all live there. Node-API only, so one build works for Node and Electron alike.
// AssertMacros.h (pulled in by Cocoa) defines check()/verify()/require() macros that collide with other headers.
#define __ASSERT_MACROS_DEFINE_VERSIONS_WITHOUT_UNDERSCORES 0
#import <Cocoa/Cocoa.h>

#include <napi.h>

#include <string>
#include <vector>

namespace {

NSData* ToNSData(const Napi::Value& value) {
  if (!value.IsBuffer()) return nil;
  Napi::Buffer<uint8_t> buffer = value.As<Napi::Buffer<uint8_t>>();
  return [NSData dataWithBytes:buffer.Data() length:buffer.Length()];
}

/// An image for a 16-point menu item from PNG bytes [1x, 2x] (JavaScript reads the files — inside
/// app.asar they are not plain files), so macOS picks the 1x or 2x bitmap by the screen like it does
/// for its own icons.
NSImage* MenuImageFromReps(const Napi::Value& pair) {
  if (!pair.IsArray()) return nil;
  Napi::Array reps = pair.As<Napi::Array>();
  NSImage* image = [[NSImage alloc] initWithSize:NSMakeSize(16, 16)];
  BOOL any = NO;
  for (uint32_t i = 0; i < reps.Length(); i++) {
    NSData* data = ToNSData(reps.Get(i));
    if (!data) continue;
    NSBitmapImageRep* rep = [[NSBitmapImageRep alloc] initWithData:data];
    if (!rep) continue;
    rep.size = NSMakeSize(16, 16);  // both reps are 16 points; their pixel size decides the scale
    [image addRepresentation:rep];
    any = YES;
  }
  return any ? image : nil;
}

}  // namespace

/// The geometry of a drawn row, in points (JavaScript's values; defaults like a Big Sur menu).
struct NCBRowMetrics {
  CGFloat rowHeight = 22;
  CGFloat imageX = 12;
  CGFloat textX = 36;
  CGFloat keyRightInset = 14;
  CGFloat highlightInsetX = 5;
  CGFloat highlightInsetY = 0;
  CGFloat cornerRadius = 5;
};

/// A menu row drawn by hand for an item that must not close the menu. Reads everything it shows
/// (title, image, enabled, highlighted, key equivalent) from its NSMenuItem at draw time, so the
/// spinner's frames and JavaScript's updates show without further ado. Two layers: the system's
/// selection highlight (an NSVisualEffectView, what Apple recommends for custom menu item views)
/// and, above it, a transparent view that draws image, title and key equivalent.
@class NCBMenuRowView;

@interface NCBRowContentView : NSView
@property(nonatomic, weak) NCBMenuRowView* row;
@end

@interface NCBMenuRowView : NSView
@property(nonatomic, strong) NSVisualEffectView* highlight;
@property(nonatomic, strong) NCBRowContentView* content;
@property(nonatomic) NCBRowMetrics metrics;
@property(nonatomic) BOOL blinking;
- (instancetype)initWithMetrics:(NCBRowMetrics)metrics;
- (BOOL)isHighlightedRow;
- (void)performClick;
- (void)finishClick;
@end

@implementation NCBRowContentView

- (BOOL)isFlipped {
  return YES;
}

- (NSView*)hitTest:(NSPoint)point {
  return nil;  // the row underneath takes the mouse
}

- (NSString*)keyEquivalentText:(NSMenuItem*)item {
  if (item.keyEquivalent.length == 0) return @"";
  NSEventModifierFlags flags = item.keyEquivalentModifierMask;
  NSMutableString* text = [NSMutableString string];
  if (flags & NSEventModifierFlagControl) [text appendString:@"⌃"];
  if (flags & NSEventModifierFlagOption) [text appendString:@"⌥"];
  if (flags & NSEventModifierFlagShift) [text appendString:@"⇧"];
  if (flags & NSEventModifierFlagCommand) [text appendString:@"⌘"];
  [text appendString:[item.keyEquivalent uppercaseString]];
  return text;
}

- (void)drawRect:(NSRect)dirtyRect {
  NCBMenuRowView* row = self.row;
  NSMenuItem* item = self.enclosingMenuItem;
  if (!row || !item) return;
  NCBRowMetrics metrics = row.metrics;
  BOOL highlighted = [row isHighlightedRow];
  NSFont* font = [NSFont menuFontOfSize:0];
  NSColor* textColor = highlighted ? [NSColor selectedMenuItemTextColor] : item.enabled ? [NSColor labelColor] : [NSColor disabledControlTextColor];
  CGFloat middle = NSMidY(self.bounds);
  if (item.image) {
    NSSize size = item.image.size;
    NSRect imageRect = NSMakeRect(metrics.imageX, middle - size.height / 2, size.width, size.height);
    [item.image drawInRect:imageRect fromRect:NSZeroRect operation:NSCompositingOperationSourceOver fraction:item.enabled ? 1.0 : 0.4 respectFlipped:YES hints:nil];
  }
  NSDictionary* attributes = @{NSFontAttributeName : font, NSForegroundColorAttributeName : textColor};
  NSString* title = item.title ?: @"";
  NSSize titleSize = [title sizeWithAttributes:attributes];
  [title drawAtPoint:NSMakePoint(metrics.textX, middle - titleSize.height / 2) withAttributes:attributes];
  NSString* key = [self keyEquivalentText:item];
  if (key.length) {
    NSColor* keyColor = highlighted ? [NSColor selectedMenuItemTextColor] : [NSColor secondaryLabelColor];
    NSDictionary* keyAttributes = @{NSFontAttributeName : font, NSForegroundColorAttributeName : keyColor};
    NSSize keySize = [key sizeWithAttributes:keyAttributes];
    [key drawAtPoint:NSMakePoint(NSMaxX(self.bounds) - metrics.keyRightInset - keySize.width, middle - keySize.height / 2) withAttributes:keyAttributes];
  }
}

@end

@implementation NCBMenuRowView

- (instancetype)initWithMetrics:(NCBRowMetrics)metrics {
  if ((self = [super initWithFrame:NSMakeRect(0, 0, 220, metrics.rowHeight)])) {
    _metrics = metrics;
    self.autoresizingMask = NSViewWidthSizable;
    NSVisualEffectView* highlight = [[NSVisualEffectView alloc] initWithFrame:NSInsetRect(self.bounds, metrics.highlightInsetX, metrics.highlightInsetY)];
    highlight.material = NSVisualEffectMaterialSelection;
    highlight.blendingMode = NSVisualEffectBlendingModeBehindWindow;
    highlight.state = NSVisualEffectStateActive;
    highlight.emphasized = YES;
    highlight.wantsLayer = YES;
    highlight.layer.cornerRadius = metrics.cornerRadius;
    highlight.layer.masksToBounds = YES;
    highlight.hidden = YES;
    highlight.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    [self addSubview:highlight];
    _highlight = highlight;
    NCBRowContentView* content = [[NCBRowContentView alloc] initWithFrame:self.bounds];
    content.row = self;
    content.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    [self addSubview:content];
    _content = content;
    [self addTrackingArea:[[NSTrackingArea alloc] initWithRect:NSZeroRect
                                                       options:NSTrackingMouseEnteredAndExited | NSTrackingActiveAlways | NSTrackingInVisibleRect
                                                         owner:self
                                                      userInfo:nil]];
  }
  return self;
}

- (BOOL)isFlipped {
  return YES;
}

- (BOOL)isHighlightedRow {
  NSMenuItem* item = self.enclosingMenuItem;
  return item && item.enabled && item.highlighted && !self.blinking;
}

/// Everything that can change what the row shows ends here: the highlight follows the item, the
/// content redraws.
- (void)setNeedsDisplay:(BOOL)flag {
  [super setNeedsDisplay:flag];
  if (flag) {
    self.highlight.hidden = ![self isHighlightedRow];
    [self.content setNeedsDisplay:YES];
  }
}

- (void)drawRect:(NSRect)dirtyRect {
  self.highlight.hidden = ![self isHighlightedRow];
}

- (void)mouseEntered:(NSEvent*)event { [self setNeedsDisplay:YES]; }
- (void)mouseExited:(NSEvent*)event { [self setNeedsDisplay:YES]; }
- (void)mouseDown:(NSEvent*)event {}      // not the menu's business: the row handles its own click
- (void)mouseDragged:(NSEvent*)event {}

/// The click: the native blink of the highlight, then the item's action — and no cancelTracking, so
/// the menu stays where it is.
- (void)mouseUp:(NSEvent*)event {
  NSPoint point = [self convertPoint:event.locationInWindow fromView:nil];
  if (!NSPointInRect(point, self.bounds)) return;
  [self performClick];
}

- (void)performClick {
  NSMenuItem* item = self.enclosingMenuItem;
  if (!item || !item.enabled || self.blinking) return;
  self.blinking = YES;
  [self setNeedsDisplay:YES];
  // Common run-loop modes: the menu's tracking loop is where this has to fire.
  [self performSelector:@selector(finishClick) withObject:nil afterDelay:0.06 inModes:@[ NSRunLoopCommonModes ]];
}

// Keyboard (0.37.13): the menu hands key events to the highlighted item's view. Return, Enter and
// Space press the row like a native item would; everything else (arrows, Escape, typing to select)
// goes on to the menu.
- (BOOL)acceptsFirstResponder {
  return YES;
}

- (void)keyDown:(NSEvent*)event {
  NSString* characters = event.charactersIgnoringModifiers;
  unichar key = characters.length ? [characters characterAtIndex:0] : 0;
  if (key == NSCarriageReturnCharacter || key == NSEnterCharacter || key == ' ') {
    [self performClick];
    return;
  }
  [super keyDown:event];
}

// VoiceOver (0.37.13): the row is a menu item — title, enabled, its key equivalent, and a press.
- (BOOL)isAccessibilityElement {
  return YES;
}

- (NSAccessibilityRole)accessibilityRole {
  return NSAccessibilityMenuItemRole;
}

- (NSString*)accessibilityRoleDescription {
  return NSAccessibilityRoleDescription(NSAccessibilityMenuItemRole, nil);
}

- (NSString*)accessibilityLabel {
  return self.enclosingMenuItem.title ?: @"";
}

- (id)accessibilityTitle {
  return self.enclosingMenuItem.title ?: @"";
}

- (BOOL)isAccessibilityEnabled {
  return self.enclosingMenuItem.enabled;
}

- (BOOL)isAccessibilitySelected {
  return self.enclosingMenuItem.highlighted;
}

- (NSString*)accessibilityMenuItemCmdChar {
  NSString* key = self.enclosingMenuItem.keyEquivalent;
  return key.length ? [key uppercaseString] : nil;
}

- (NSNumber*)accessibilityMenuItemCmdModifiers {
  NSEventModifierFlags flags = self.enclosingMenuItem.keyEquivalentModifierMask;
  // AXMenuItemCmdModifiers: bit 0 = no command key, bit 1 = shift, bit 2 = option, bit 3 = control.
  NSUInteger value = (flags & NSEventModifierFlagCommand) ? 0 : 1;
  if (flags & NSEventModifierFlagShift) value |= 2;
  if (flags & NSEventModifierFlagOption) value |= 4;
  if (flags & NSEventModifierFlagControl) value |= 8;
  return @(value);
}

- (BOOL)accessibilityPerformPress {
  [self performClick];
  return YES;
}

- (void)finishClick {
  self.blinking = NO;
  [self setNeedsDisplay:YES];
  NSMenuItem* item = self.enclosingMenuItem;
  if (item && item.target && item.action) {
    [NSApp sendAction:item.action to:item.target from:item];
  }
}

@end

@interface NCBMenuSpinner : NSObject
@property(nonatomic, strong) NSIndexSet* spinningIndexes;  // the items that spin (0.37.15: one per syncing account)
@property(nonatomic, strong) NSArray<NSImage*>* frames;  // the default set (green)
/// 0.45.2: further sets of frames by name (e.g. "warning": yellow), and which set each turning item uses.
@property(nonatomic, strong) NSMutableDictionary<NSString*, NSArray<NSImage*>*>* frameSets;
@property(nonatomic, strong) NSDictionary<NSNumber*, NSString*>* spinningSets;
@property(nonatomic) NSTimeInterval interval;
@property(nonatomic, strong) NSMenu* trackedMenu;  // the menu-bar menu while it is open
@property(nonatomic, strong) NSTimer* timer;
@property(nonatomic) NSUInteger frame;
/// The items the timer is turning, by index, with the image each had when its spinning started.
@property(nonatomic, strong) NSMutableDictionary<NSNumber*, NSImage*>* spinningItems;
@property(nonatomic, strong) NSIndexSet* keepOpenIndexes;    // the items that keep the menu open (drawn rows)
@property(nonatomic) NCBRowMetrics rowMetrics;
- (void)applyKeepOpen;
- (void)menuDidBeginTracking:(NSNotification*)notification;
- (void)menuDidEndTracking:(NSNotification*)notification;
- (void)applySpinning;
- (void)advance;
- (void)stopSpinning;
- (void)stopSpinningItem:(NSNumber*)index;
- (void)stopTimer;
- (NSArray<NSImage*>*)framesForIndex:(NSNumber*)index;
- (BOOL)isFrameImage:(NSImage*)image;
- (BOOL)isTracking;
- (void)updateItem:(NSInteger)index title:(NSString*)title image:(NSImage*)image hasImage:(BOOL)hasImage enabled:(BOOL)enabled;
@end

@implementation NCBMenuSpinner

- (instancetype)init {
  if ((self = [super init])) {
    _spinningIndexes = [NSIndexSet indexSet];
    _spinningItems = [NSMutableDictionary dictionary];
    _interval = 1.0 / 12.0;
    _frames = @[];
    _frameSets = [NSMutableDictionary dictionary];
    _spinningSets = @{};
    _keepOpenIndexes = [NSIndexSet indexSet];
    NSNotificationCenter* center = [NSNotificationCenter defaultCenter];
    [center addObserver:self selector:@selector(menuDidBeginTracking:) name:NSMenuDidBeginTrackingNotification object:nil];
    [center addObserver:self selector:@selector(menuDidEndTracking:) name:NSMenuDidEndTrackingNotification object:nil];
  }
  return self;
}

- (void)dealloc {
  [[NSNotificationCenter defaultCenter] removeObserver:self];
  [self stopTimer];
}

/// The menu-bar menu: a root menu that is not the application menu, and one of Electron's own
/// (its tray and application menus have an ElectronMenuController as delegate; Chromium's <select>
/// pop-ups and AppKit's pop-up buttons, also root menus, do not).
- (BOOL)isMenuBarMenu:(NSMenu*)menu {
  if (!menu || menu == [NSApp mainMenu] || menu.supermenu != nil) return NO;
  id delegate = menu.delegate;
  if (!delegate) return NO;
  NSString* className = NSStringFromClass([delegate class]);
  return [className rangeOfString:@"ElectronMenuController"].location != NSNotFound;
}

/// Whether the menu-bar menu is open (between its begin- and end-of-tracking notifications).
- (BOOL)isTracking {
  return self.trackedMenu != nil;
}

- (void)menuDidBeginTracking:(NSNotification*)notification {
  NSMenu* menu = notification.object;
  if (![self isMenuBarMenu:menu]) return;
  self.trackedMenu = menu;
  [self applyKeepOpen];
  [self applySpinning];
}

/// The keep-open items of the menu that is open get their drawn row (once per menu; Electron builds
/// a new NSMenu whenever the items change, and JavaScript names the indexes again for it).
- (void)applyKeepOpen {
  NSMenu* menu = self.trackedMenu;
  if (!menu) return;
  NCBRowMetrics metrics = self.rowMetrics;
  [self.keepOpenIndexes enumerateIndexesUsingBlock:^(NSUInteger index, BOOL* stop) {
    if ((NSInteger)index >= menu.numberOfItems) return;
    NSMenuItem* item = [menu itemAtIndex:index];
    if (item.separatorItem || [item.view isKindOfClass:[NCBMenuRowView class]]) return;
    item.view = [[NCBMenuRowView alloc] initWithMetrics:metrics];
  }];
}

- (void)menuDidEndTracking:(NSNotification*)notification {
  if (notification.object != self.trackedMenu) return;
  [self stopSpinning];
  self.trackedMenu = nil;
}

- (NSMenuItem*)trackedItemAt:(NSInteger)index {
  NSMenu* menu = self.trackedMenu;
  if (!menu || index < 0 || index >= menu.numberOfItems) return nil;
  return [menu itemAtIndex:index];
}

/// Makes the set of turning items match spinningIndexes for the menu that is open: items no longer
/// wanted get their image back, new ones start, and one timer runs while any item turns.
- (void)applySpinning {
  if (!self.trackedMenu || self.frames.count == 0) return;
  for (NSNumber* index in [self.spinningItems.allKeys copy]) {
    if (![self.spinningIndexes containsIndex:index.unsignedIntegerValue]) {
      [self stopSpinningItem:index];
    }
  }
  [self.spinningIndexes enumerateIndexesUsingBlock:^(NSUInteger index, BOOL* stop) {
    NSNumber* key = @(index);
    if (self.spinningItems[key]) return;  // already turning
    NSMenuItem* item = [self trackedItemAt:(NSInteger)index];
    if (!item) return;
    self.spinningItems[key] = item.image ?: (NSImage*)[NSNull null];
  }];
  if (self.spinningItems.count == 0) {
    [self stopTimer];
    return;
  }
  if (self.timer) return;
  self.frame = self.frames.count - 1;  // advance starts with frame 0
  __weak NCBMenuSpinner* weakSelf = self;
  self.timer = [NSTimer timerWithTimeInterval:self.interval
                                      repeats:YES
                                        block:^(NSTimer* timer) {
                                          [weakSelf advance];
                                        }];
  // Common modes include event tracking, which is the mode the run loop is in while a menu is open.
  [[NSRunLoop mainRunLoop] addTimer:self.timer forMode:NSRunLoopCommonModes];
  [self advance];
}

/// The frames an item turns with: its named set (0.45.2), else the default one.
- (NSArray<NSImage*>*)framesForIndex:(NSNumber*)index {
  NSString* name = self.spinningSets[index];
  NSArray<NSImage*>* frameSet = name.length ? self.frameSets[name] : nil;
  return frameSet.count ? frameSet : self.frames;
}

/// Whether an image is one of the frames (of any set): such an item still shows the spinner.
- (BOOL)isFrameImage:(NSImage*)image {
  if (!image) return NO;
  if ([self.frames containsObject:image]) return YES;
  for (NSArray<NSImage*>* frameSet in self.frameSets.allValues) {
    if ([frameSet containsObject:image]) return YES;
  }
  return NO;
}

/// All turning items show the same step (they turn in step, like one symbol), each in its own set's colour.
- (void)advance {
  if (self.frames.count == 0 || self.spinningItems.count == 0) {
    [self stopSpinning];
    return;
  }
  self.frame = (self.frame + 1) % self.frames.count;
  for (NSNumber* index in [self.spinningItems.allKeys copy]) {
    NSMenuItem* item = [self trackedItemAt:index.integerValue];
    if (!item) {
      [self.spinningItems removeObjectForKey:index];
      continue;
    }
    NSArray<NSImage*>* frameSet = [self framesForIndex:index];
    item.image = frameSet[self.frame % frameSet.count];
    [item.view setNeedsDisplay:YES];
  }
}

- (void)stopTimer {
  [self.timer invalidate];
  self.timer = nil;
}

/// One item stops turning: it gets the image it had before (unless JavaScript gave it another one meanwhile).
- (void)stopSpinningItem:(NSNumber*)index {
  id before = self.spinningItems[index];
  [self.spinningItems removeObjectForKey:index];
  NSMenuItem* item = [self trackedItemAt:index.integerValue];
  if (item && [self isFrameImage:item.image]) {
    item.image = [before isKindOfClass:[NSImage class]] ? (NSImage*)before : nil;
    [item.view setNeedsDisplay:YES];
  }
}

/// Stops the timer and every turning item.
- (void)stopSpinning {
  [self stopTimer];
  for (NSNumber* index in [self.spinningItems.allKeys copy]) {
    [self stopSpinningItem:index];
  }
}

/// JavaScript changed an item (a sync started or ended while the menu is open). hasImage says
/// whether an image was passed at all (nil image + hasImage = the item gets no image).
- (void)updateItem:(NSInteger)index title:(NSString*)title image:(NSImage*)image hasImage:(BOOL)hasImage enabled:(BOOL)enabled {
  NSMenuItem* item = [self trackedItemAt:index];
  if (!item) return;
  if (title) item.title = title;
  if (hasImage) {
    if (self.spinningItems[@(index)]) {
      self.spinningItems[@(index)] = image ?: (NSImage*)[NSNull null];  // keep turning; the still image for when it stops
    } else {
      item.image = image;
    }
  }
  item.enabled = enabled;
  [item.view setNeedsDisplay:YES];
}

@end

namespace {

NCBMenuSpinner* Spinner() {
  static NCBMenuSpinner* spinner = [[NCBMenuSpinner alloc] init];
  return spinner;
}

NSString* ToNSString(const Napi::Value& value) {
  if (!value.IsString()) return nil;
  std::string text = value.As<Napi::String>().Utf8Value();
  return [NSString stringWithUTF8String:text.c_str()];
}

/// setFrames(frames: Array<[png1x: Buffer, png2x: Buffer | null]>, intervalMs: number, set?: string) — the frames
/// of the symbol; with a set name (0.45.2), a further set an item can turn with (see setSpinning).
Napi::Value SetFrames(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsArray()) {
    Napi::TypeError::New(env, "setFrames(frames, intervalMs): frames must be an array").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  Napi::Array pairs = info[0].As<Napi::Array>();
  NSMutableArray<NSImage*>* frames = [NSMutableArray array];
  for (uint32_t i = 0; i < pairs.Length(); i++) {
    NSImage* image = MenuImageFromReps(pairs.Get(i));
    if (image) [frames addObject:image];
  }
  NCBMenuSpinner* spinner = Spinner();
  NSString* setName = info.Length() >= 3 ? ToNSString(info[2]) : nil;
  if (setName.length) {
    spinner.frameSets[setName] = frames;
  } else {
    spinner.frames = frames;
  }
  if (info.Length() >= 2 && info[1].IsNumber()) {
    double ms = info[1].As<Napi::Number>().DoubleValue();
    if (ms >= 10) spinner.interval = ms / 1000.0;
  }
  return Napi::Number::New(env, static_cast<double>(frames.count));
}

/// setSpinning(indexes: number | number[], sets?: string[]) — the items (by index in the menu) to turn while the
/// menu is open; -1 or an empty array for none. 0.37.15: several, one per syncing account. 0.45.2: sets, in the
/// order of indexes, names the frame set each item turns with ('' or missing: the default one).
Napi::Value SetSpinning(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  NSMutableIndexSet* indexes = [NSMutableIndexSet indexSet];
  auto add = [&](const Napi::Value& value) {
    if (!value.IsNumber()) return;
    int64_t index = value.As<Napi::Number>().Int64Value();
    if (index >= 0) [indexes addIndex:(NSUInteger)index];
  };
  NSMutableDictionary<NSNumber*, NSString*>* sets = [NSMutableDictionary dictionary];
  if (info.Length() >= 1) {
    if (info[0].IsArray()) {
      Napi::Array list = info[0].As<Napi::Array>();
      Napi::Array names = info.Length() >= 2 && info[1].IsArray() ? info[1].As<Napi::Array>() : Napi::Array::New(env);
      for (uint32_t i = 0; i < list.Length(); i++) {
        add(list.Get(i));
        if (i < names.Length() && list.Get(i).IsNumber()) {
          NSString* name = ToNSString(names.Get(i));
          int64_t index = list.Get(i).As<Napi::Number>().Int64Value();
          if (name.length && index >= 0) sets[@(index)] = name;
        }
      }
    } else {
      add(info[0]);
    }
  }
  NCBMenuSpinner* spinner = Spinner();
  spinner.spinningSets = sets;
  spinner.spinningIndexes = indexes;
  [spinner applySpinning];
  return env.Undefined();
}

/// updateItem(index, title, [png1x, png2x] | null, enabled) — change an item of the menu while it is open
/// (null: the item gets no image; undefined: the image stays).
Napi::Value UpdateItem(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsNumber()) return env.Undefined();
  NSInteger index = info[0].As<Napi::Number>().Int64Value();
  NSString* title = info.Length() >= 2 ? ToNSString(info[1]) : nil;
  BOOL hasImage = info.Length() >= 3 && !info[2].IsUndefined();
  NSImage* image = hasImage ? MenuImageFromReps(info[2]) : nil;
  BOOL enabled = info.Length() >= 4 && info[3].IsBoolean() ? info[3].As<Napi::Boolean>().Value() : YES;
  [Spinner() updateItem:index title:title image:image hasImage:hasImage enabled:enabled];
  return env.Undefined();
}

/// setKeepOpen(indexes: number[], metrics?: {rowHeight, imageX, textX, keyRightInset, highlightInsetX,
/// highlightInsetY, cornerRadius}) — the items (by index) whose click keeps the menu open, and the
/// geometry of their drawn rows. Applied to the menu the next time it opens (and to an open one at once).
Napi::Value SetKeepOpen(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  NSMutableIndexSet* indexes = [NSMutableIndexSet indexSet];
  if (info.Length() >= 1 && info[0].IsArray()) {
    Napi::Array list = info[0].As<Napi::Array>();
    for (uint32_t i = 0; i < list.Length(); i++) {
      Napi::Value value = list.Get(i);
      if (value.IsNumber()) {
        int64_t index = value.As<Napi::Number>().Int64Value();
        if (index >= 0) [indexes addIndex:(NSUInteger)index];
      }
    }
  }
  NCBMenuSpinner* spinner = Spinner();
  if (info.Length() >= 2 && info[1].IsObject()) {
    Napi::Object metrics = info[1].As<Napi::Object>();
    NCBRowMetrics values = spinner.rowMetrics;
    auto read = [&](const char* name, CGFloat& into) {
      Napi::Value value = metrics.Get(name);
      if (value.IsNumber()) into = value.As<Napi::Number>().DoubleValue();
    };
    read("rowHeight", values.rowHeight);
    read("imageX", values.imageX);
    read("textX", values.textX);
    read("keyRightInset", values.keyRightInset);
    read("highlightInsetX", values.highlightInsetX);
    read("highlightInsetY", values.highlightInsetY);
    read("cornerRadius", values.cornerRadius);
    spinner.rowMetrics = values;
  }
  spinner.keepOpenIndexes = indexes;
  [spinner applyKeepOpen];
  return env.Undefined();
}

/// isTracking() — whether the menu-bar menu is open right now.
Napi::Value IsTracking(const Napi::CallbackInfo& info) {
  return Napi::Boolean::New(info.Env(), [Spinner() isTracking]);
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("setFrames", Napi::Function::New(env, SetFrames));
  exports.Set("setSpinning", Napi::Function::New(env, SetSpinning));
  exports.Set("updateItem", Napi::Function::New(env, UpdateItem));
  exports.Set("setKeepOpen", Napi::Function::New(env, SetKeepOpen));
  exports.Set("isTracking", Napi::Function::New(env, IsTracking));
  exports.Set("supported", Napi::Boolean::New(env, true));
  return exports;
}

}  // namespace

NODE_API_MODULE(menu_spinner, Init)
