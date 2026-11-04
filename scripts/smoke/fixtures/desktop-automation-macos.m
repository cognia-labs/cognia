#import <Cocoa/Cocoa.h>
#import <CoreGraphics/CoreGraphics.h>
#include <string.h>

// Disposable external apps are required to observe actual OS input recipients.
// The in-app E2E bridge cannot supply an independent spectator window.
static NSString *statePath;
static NSString *commandPath;

@interface FixtureDelegate : NSObject <NSApplicationDelegate, NSTextFieldDelegate, NSWindowDelegate>
@property NSMutableArray<NSWindow *> *windows;
@property NSMutableArray<NSTextField *> *fields;
@property NSMutableArray<NSNumber *> *clicks;
@property NSString *lastCommand;
@property BOOL interruptClicks;
- (void)save;
@end

@implementation FixtureDelegate
- (void)save {
  NSMutableArray *windows = [NSMutableArray new];
  double height = CGDisplayBounds(CGMainDisplayID()).size.height;
  for (NSUInteger index = 0; index < self.windows.count; index++) {
    NSWindow *window = self.windows[index];
    NSRect frame = window.frame;
    NSArray *windowInfo = CFBridgingRelease(CGWindowListCopyWindowInfo(kCGWindowListOptionIncludingWindow, (CGWindowID)window.windowNumber));
    [windows addObject:@{
      @"title": window.title,
      @"nativeWindowId": @(window.windowNumber),
      @"cgWindow": windowInfo.firstObject ?: @{},
      @"frame": @{@"x": @(frame.origin.x), @"y": @(height - NSMaxY(frame)),
                  @"width": @(frame.size.width), @"height": @(frame.size.height)},
      @"primary": self.fields[index * 2].stringValue,
      @"secondary": self.fields[index * 2 + 1].stringValue,
      @"clicks": self.clicks[index]
    }];
  }
  NSMutableArray *screens = [NSMutableArray new];
  for (NSScreen *screen in NSScreen.screens) {
    NSNumber *display = screen.deviceDescription[@"NSScreenNumber"];
    CGRect bounds = CGDisplayBounds(display.unsignedIntValue);
    [screens addObject:@{@"id": display.stringValue,
      @"x": @(bounds.origin.x), @"y": @(bounds.origin.y),
      @"width": @(bounds.size.width), @"height": @(bounds.size.height),
      @"scale": @(screen.backingScaleFactor)}];
  }
  NSDictionary *snapshot = @{@"pid": @(getpid()), @"bundleId": NSBundle.mainBundle.bundleIdentifier,
    @"windows": windows, @"screens": screens, @"lastCommand": self.lastCommand ?: @"",
    @"active": @(NSApp.active), @"activationPolicy": @(NSApp.activationPolicy),
    @"finishedLaunching": @(NSRunningApplication.currentApplication.finishedLaunching),
    @"keyWindow": NSApp.keyWindow.title ?: @""};
  NSData *data = [NSJSONSerialization dataWithJSONObject:snapshot options:NSJSONWritingPrettyPrinted error:nil];
  [data writeToFile:statePath options:NSDataWritingAtomic error:nil];
}

- (void)applicationDidFinishLaunching:(NSNotification *)notification {
  self.windows = [NSMutableArray new];
  self.fields = [NSMutableArray new];
  self.clicks = [NSMutableArray new];
  for (NSInteger index = 0; index < 2; index++) {
    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(80 + index * 660, 200, 600, 360)
      styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskResizable
      backing:NSBackingStoreBuffered defer:NO];
    window.title = [NSString stringWithFormat:@"P1 fixture window %ld", (long)index];
    window.delegate = self;
    for (NSInteger fieldIndex = 0; fieldIndex < 2; fieldIndex++) {
      NSTextField *field = [[NSTextField alloc] initWithFrame:NSMakeRect(20, 280 - fieldIndex * 80, 550, 40)];
      field.stringValue = [NSString stringWithFormat:@"seed-%ld-%ld", (long)index, (long)fieldIndex];
      field.identifier = [NSString stringWithFormat:@"fixture-field-%ld-%ld", (long)index, (long)fieldIndex];
      field.accessibilityIdentifier = field.identifier;
      if (fieldIndex == 0) [field setAccessibilityLabel:field.identifier];
      field.delegate = self;
      [window.contentView addSubview:field];
      [self.fields addObject:field];
    }
    NSButton *button = [[NSButton alloc] initWithFrame:NSMakeRect(20, 100, 240, 50)];
    button.title = [NSString stringWithFormat:@"Increment %ld", (long)index];
    button.identifier = [NSString stringWithFormat:@"fixture-button-%ld", (long)index];
    button.accessibilityIdentifier = button.identifier;
    button.tag = index;
    button.target = self;
    button.action = @selector(increment:);
    [window.contentView addSubview:button];
    [self.windows addObject:window];
    [self.clicks addObject:@0];
    [window orderFront:nil];
  }
  [self.windows[0] makeKeyAndOrderFront:nil];
  [self.windows[0] makeFirstResponder:self.fields[0]];
  [NSApp activateIgnoringOtherApps:YES];
  [NSTimer scheduledTimerWithTimeInterval:0.025 target:self selector:@selector(readCommand:) userInfo:nil repeats:YES];
  [NSTimer scheduledTimerWithTimeInterval:0.1 repeats:NO block:^(NSTimer *timer) { [self save]; }];
  [self save];
}

- (void)applicationDidBecomeActive:(NSNotification *)notification { [self save]; }
- (void)applicationDidResignActive:(NSNotification *)notification { [self save]; }
- (void)windowDidBecomeKey:(NSNotification *)notification { [self save]; }
- (void)windowDidResignKey:(NSNotification *)notification { [self save]; }

- (void)increment:(NSButton *)sender {
  self.clicks[sender.tag] = @(self.clicks[sender.tag].integerValue + 1);
  if (self.interruptClicks) {
    [self.windows[1] makeKeyAndOrderFront:nil];
    [self.windows[1] makeFirstResponder:self.fields[2]];
  }
  [self save];
}

- (void)controlTextDidChange:(NSNotification *)notification { [self save]; }

- (void)readCommand:(NSTimer *)timer {
  NSData *data = [NSData dataWithContentsOfFile:commandPath];
  if (!data) return;
  NSDictionary *command = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
  if (![command isKindOfClass:NSDictionary.class] || [command[@"id"] isEqual:self.lastCommand]) return;
  self.lastCommand = command[@"id"];
  NSUInteger index = [command[@"window"] unsignedIntegerValue];
  if (index >= self.windows.count) return;
  NSWindow *window = self.windows[index];
  NSString *kind = command[@"kind"];
  if ([kind isEqualToString:@"move"]) {
    NSRect frame = window.frame;
    frame.origin.x = [command[@"x"] doubleValue];
    frame.origin.y = CGDisplayBounds(CGMainDisplayID()).size.height - [command[@"y"] doubleValue] - frame.size.height;
    if (command[@"width"]) frame.size.width = [command[@"width"] doubleValue];
    [window setFrame:frame display:YES];
  } else if ([kind isEqualToString:@"focus"]) {
    [window makeKeyAndOrderFront:nil];
    [window makeFirstResponder:self.fields[index * 2 + [command[@"field"] unsignedIntegerValue] % 2]];
    [NSApp activateIgnoringOtherApps:YES];
  } else if ([kind isEqualToString:@"interruptClicks"]) {
    self.interruptClicks = [command[@"enabled"] boolValue];
  } else if ([kind isEqualToString:@"quit"]) {
    [NSApp terminate:nil];
    return;
  }
  [self save];
}
@end

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc == 2 && strcmp(argv[1], "--session-status") == 0) {
      NSDictionary *session = CFBridgingRelease(CGSessionCopyCurrentDictionary());
      NSDictionary *status = @{
        @"locked": @([session[@"CGSSessionScreenIsLocked"] boolValue]),
        @"onConsole": @([session[@"kCGSSessionOnConsoleKey"] boolValue])
      };
      NSData *json = [NSJSONSerialization dataWithJSONObject:status options:0 error:nil];
      puts([[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding].UTF8String);
      return 0;
    }
    if (argc != 3) return 2;
    statePath = [NSString stringWithUTF8String:argv[1]];
    commandPath = [NSString stringWithUTF8String:argv[2]];
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
    FixtureDelegate *delegate = [FixtureDelegate new];
    NSApp.delegate = delegate;
    [NSApp run];
  }
  return 0;
}
