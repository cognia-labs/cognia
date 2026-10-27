// ADR-0242. No private Objective-C class is statically referenced or linked.
#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <IOKit/IOKitLib.h>
#import <IOKit/pwr_mgt/IOPMLib.h>
#include <stdbool.h>
#include <unistd.h>

@protocol CogniaVDDescriptor <NSObject>
- (instancetype)init;
@property(nonatomic) unsigned int maxPixelsWide;
@property(nonatomic) unsigned int maxPixelsHigh;
@property(nonatomic) unsigned int vendorID;
@property(nonatomic) unsigned int productID;
@property(nonatomic) unsigned int serialNum;
@property(nonatomic) CGSize sizeInMillimeters;
@property(nonatomic) CGPoint redPrimary;
@property(nonatomic) CGPoint greenPrimary;
@property(nonatomic) CGPoint bluePrimary;
@property(nonatomic) CGPoint whitePoint;
@property(nonatomic, copy) NSString *name;
@property(nonatomic, retain) dispatch_queue_t queue;
@end
@protocol CogniaVDSettings <NSObject>
- (instancetype)init;
@property(nonatomic) unsigned int hiDPI;
@property(nonatomic, copy) NSArray *modes;
@end
@protocol CogniaVDMode <NSObject>
- (instancetype)initWithWidth:(unsigned int)width height:(unsigned int)height refreshRate:(double)rate;
@end
@protocol CogniaVDDisplay <NSObject>
- (instancetype)initWithDescriptor:(id)descriptor;
- (BOOL)applySettings:(id)settings;
@property(nonatomic, readonly) unsigned int displayID;
@end

typedef struct {
    uint32_t display_id;
    double x, y, width, height;
} CogniaVDGeometry;

@interface CogniaVDHandle : NSObject
@property(nonatomic, strong) id<CogniaVDDisplay> display;
@property(nonatomic, strong) NSArray<NSDictionary *> *origins;
@property(nonatomic, strong) NSMutableArray<NSDictionary *> *windows;
@property(nonatomic) IOPMAssertionID assertion;
@property(nonatomic) BOOL hasAssertion;
@property(nonatomic) BOOL layoutChanged;
@property(atomic) int32_t invalidationCode;
@property(nonatomic) int32_t physicalOffset;
@property(nonatomic, strong) id sleepObserver;
@property(nonatomic, strong) id sessionObserver;
@property(nonatomic, strong) id lockObserver;
@end
@implementation CogniaVDHandle
@end

// Serialize target-window changes with teardown. No automation event is posted
// from notification callbacks; they only latch invalidation until release.
static NSRecursiveLock *cognia_vd_lock;
static CogniaVDHandle *cognia_vd_owned;
static NSRecursiveLock *cognia_vd_mutex(void) {
    static dispatch_once_t once;
    dispatch_once(&once, ^{ cognia_vd_lock = [[NSRecursiveLock alloc] init]; });
    return cognia_vd_lock;
}

bool cognia_vd_installed(void) {
    @autoreleasepool {
        return NSClassFromString(@"CGVirtualDisplay") != Nil &&
               NSClassFromString(@"CGVirtualDisplayDescriptor") != Nil &&
               NSClassFromString(@"CGVirtualDisplaySettings") != Nil &&
               NSClassFromString(@"CGVirtualDisplayMode") != Nil;
    }
}

int32_t cognia_vd_check(void) {
    @autoreleasepool {
        if (!cognia_vd_installed() ||
            ![NSProcessInfo.processInfo isOperatingSystemAtLeastVersion:(NSOperatingSystemVersion){14,4,0}]) return 1;
        NSDictionary *session = CFBridgingRelease(CGSessionCopyCurrentDictionary());
        // Unknown session evidence must deny. CGSSessionScreenIsLocked is
        // absent on some unlocked systems, while OnConsoleKey must be true.
        if (session == nil || ![session[(__bridge NSString *)kCGSessionOnConsoleKey] boolValue] ||
            [session[@"CGSSessionScreenIsLocked"] boolValue]) return 3;
        if (!CGPreflightScreenCaptureAccess() || !AXIsProcessTrusted()) return 2;
        io_registry_entry_t root = IOServiceGetMatchingService(kIOMainPortDefault, IOServiceMatching("IOPMrootDomain"));
        if (root == IO_OBJECT_NULL) return 1; // cannot establish lid-open state
        CFTypeRef lid = IORegistryEntryCreateCFProperty(root, CFSTR("AppleClamshellState"), kCFAllocatorDefault, 0);
        IOObjectRelease(root);
        // Desktop Macs have no clamshell property.
        bool closed = lid != NULL && CFGetTypeID(lid) == CFBooleanGetTypeID() && CFBooleanGetValue((CFBooleanRef)lid);
        if (lid != NULL) CFRelease(lid);
        if (closed) return 5;
        [cognia_vd_mutex() lock];
        int32_t invalidation = cognia_vd_owned.invalidationCode;
        [cognia_vd_mutex() unlock];
        return invalidation;
    }
}

static NSArray<NSDictionary *> *cognia_vd_origins(void) {
    CGDirectDisplayID displays[64];
    uint32_t count = 0;
    if (CGGetActiveDisplayList(64, displays, &count) != kCGErrorSuccess || count == 64) return nil;
    NSMutableArray *origins = [NSMutableArray array];
    for (uint32_t i = 0; i < count; i++) {
        // Do not rewrite a mirror set whose topology cannot be restored by
        // origins alone. Sidecar/DisplayLink in extended mode are untouched.
        if (CGDisplayIsInMirrorSet(displays[i])) return nil;
        CGRect bounds = CGDisplayBounds(displays[i]);
        [origins addObject:@{@"id": @(displays[i]), @"x": @(bounds.origin.x), @"y": @(bounds.origin.y)}];
    }
    return origins;
}

static int32_t cognia_vd_restore(CogniaVDHandle *handle) {
    int32_t result = 0;
    NSNotificationCenter *center = NSWorkspace.sharedWorkspace.notificationCenter;
    if (handle.sleepObserver != nil) [center removeObserver:handle.sleepObserver];
    if (handle.sessionObserver != nil) [center removeObserver:handle.sessionObserver];
    handle.sleepObserver = nil;
    handle.sessionObserver = nil;
    if (handle.lockObserver != nil) [NSDistributedNotificationCenter.defaultCenter removeObserver:handle.lockObserver];
    handle.lockObserver = nil;
    if (handle.layoutChanged) {
        CGDisplayConfigRef config = NULL;
        if (CGBeginDisplayConfiguration(&config) != kCGErrorSuccess) result = 7;
        else {
            BOOL valid = YES;
            // Move the owned origin away first; the former main becomes (0,0).
            if (handle.display != nil && CGDisplayIsOnline(handle.display.displayID)) {
                valid = CGConfigureDisplayOrigin(config, handle.display.displayID, 32700, 0) == kCGErrorSuccess;
            }
            for (NSDictionary *saved in handle.origins) {
                CGDirectDisplayID displayID = [saved[@"id"] unsignedIntValue];
                if (!CGDisplayIsOnline(displayID)) { result = 7; continue; }
                if (CGConfigureDisplayOrigin(config, displayID, [saved[@"x"] intValue], [saved[@"y"] intValue]) != kCGErrorSuccess) valid = NO;
            }
            if (!valid) { CGCancelDisplayConfiguration(config); result = 7; }
            else if (CGCompleteDisplayConfiguration(config, kCGConfigureForAppOnly) != kCGErrorSuccess) result = 7;
        }
    }
    // Restore the geometry we explicitly changed. Closed application windows
    // no longer need restoration; other AX failures remain observable.
    for (NSDictionary *saved in [handle.windows reverseObjectEnumerator]) {
        AXUIElementRef window = (__bridge AXUIElementRef)saved[@"window"];
        AXError pos = AXUIElementSetAttributeValue(window, kAXPositionAttribute, (__bridge CFTypeRef)saved[@"position"]);
        AXError size = AXUIElementSetAttributeValue(window, kAXSizeAttribute, (__bridge CFTypeRef)saved[@"size"]);
        if ((pos != kAXErrorSuccess && pos != kAXErrorInvalidUIElement) ||
            (size != kAXErrorSuccess && size != kAXErrorInvalidUIElement)) result = 7;
    }
    // ARC dropping our one reference removes only the display we created.
    CGDirectDisplayID ownedID = handle.display.displayID;
    handle.display = nil;
    if (ownedID != 0) {
        for (int i = 0; i < 30 && CGDisplayIsOnline(ownedID); i++) usleep(100000);
        if (CGDisplayIsOnline(ownedID)) result = 7;
    }
    if (handle.hasAssertion) {
        if (IOPMAssertionRelease(handle.assertion) != kIOReturnSuccess) result = 7;
        handle.hasAssertion = NO;
    }
    return result;
}

// The application that receives keyboard input, read live from AX rather than
// NSWorkspace's KVO snapshot (which only refreshes on the main run loop).
static pid_t cognia_vd_focused_pid(void) {
    AXUIElementRef system = AXUIElementCreateSystemWide();
    AXUIElementSetMessagingTimeout(system, 0.25);
    CFTypeRef app = NULL;
    pid_t pid = 0;
    if (AXUIElementCopyAttributeValue(system, kAXFocusedApplicationAttribute, &app) == kAXErrorSuccess && app != NULL) {
        if (AXUIElementGetPid((AXUIElementRef)app, &pid) != kAXErrorSuccess) pid = 0;
    }
    if (app != NULL) CFRelease(app);
    CFRelease(system);
    return pid;
}

// Bring the targeted application and its (already moved) window to the front,
// so keystrokes land in it rather than in whichever app was active (usually
// Cognia). Verified by reading the focused application back.
static int32_t cognia_vd_activate(pid_t pid, AXUIElementRef window) {
    if (cognia_vd_focused_pid() == pid) return 0;
    AXUIElementRef app = AXUIElementCreateApplication(pid);
    AXUIElementSetMessagingTimeout(app, 0.25);
    AXUIElementSetAttributeValue(app, kAXFrontmostAttribute, kCFBooleanTrue);
    CFRelease(app);
    AXUIElementSetAttributeValue(window, kAXMainAttribute, kCFBooleanTrue);
    AXUIElementPerformAction(window, kAXRaiseAction);
    NSRunningApplication *running = [NSRunningApplication runningApplicationWithProcessIdentifier:pid];
    if (running == nil) return 13;
    [running activateWithOptions:0];
    for (int i = 0; i < 20; i++) {
        if (cognia_vd_focused_pid() == pid) return 0;
        usleep(50000);
    }
    return 13;
}

// Caller holds the native mutex. Moving only the focused/main window leaves
// unrelated application windows where they were; existing windows are keyed
// by AX identity and retain their first snapshot across repeated captures.
static int32_t cognia_vd_move_window(CogniaVDHandle *handle, uint32_t pid) {
    // Only an explicitly targeted application moves. "Whatever is frontmost"
    // is usually Cognia itself, and the host's window (with its emergency
    // stop) must never leave the physical screen.
    if (pid == 0) return 9;
    if ((pid_t)pid == getpid()) return 12;
    AXUIElementRef app = AXUIElementCreateApplication((pid_t)pid);
    AXUIElementSetMessagingTimeout(app, 0.25);
    CFTypeRef windowValue = NULL;
    AXError status = AXUIElementCopyAttributeValue(app, kAXFocusedWindowAttribute, &windowValue);
    if (status != kAXErrorSuccess) status = AXUIElementCopyAttributeValue(app, kAXMainWindowAttribute, &windowValue);
    CFRelease(app);
    if (status != kAXErrorSuccess || windowValue == NULL) return 9;
    AXUIElementRef window = (AXUIElementRef)windowValue;
    AXUIElementSetMessagingTimeout(window, 0.25);
    CFTypeRef position = NULL, size = NULL;
    CGPoint point = CGPointZero;
    CGSize dimensions = CGSizeZero;
    bool readable = AXUIElementCopyAttributeValue(window, kAXPositionAttribute, &position) == kAXErrorSuccess &&
                    AXUIElementCopyAttributeValue(window, kAXSizeAttribute, &size) == kAXErrorSuccess &&
                    AXValueGetValue((AXValueRef)position, kAXValueCGPointType, &point) &&
                    AXValueGetValue((AXValueRef)size, kAXValueCGSizeType, &dimensions);
    int32_t result = 9;
    if (readable) {
        BOOL saved = NO;
        for (NSDictionary *entry in handle.windows) if (CFEqual((__bridge CFTypeRef)entry[@"window"], window)) { saved = YES; break; }
        if (!saved) {
            CGPoint original = point;
            if (original.x >= 1920) original.x -= handle.physicalOffset;
            AXValueRef originalPosition = AXValueCreate(kAXValueCGPointType, &original);
            [handle.windows addObject:@{@"window": (__bridge id)window, @"position": (__bridge id)originalPosition, @"size": (__bridge id)size}];
            CFRelease(originalPosition);
        }
        CGRect bounds = CGDisplayBounds(handle.display.displayID);
        if (CGRectContainsRect(bounds, (CGRect){ point, dimensions })) result = 0;
        else {
            point = CGPointMake(40, 40);
            dimensions.width = MIN(dimensions.width, 1840);
            dimensions.height = MIN(dimensions.height, 1000);
            AXValueRef newPosition = AXValueCreate(kAXValueCGPointType, &point);
            AXValueRef newSize = AXValueCreate(kAXValueCGSizeType, &dimensions);
            AXError resized = AXUIElementSetAttributeValue(window, kAXSizeAttribute, newSize);
            AXError moved = AXUIElementSetAttributeValue(window, kAXPositionAttribute, newPosition);
            CFRelease(newPosition);
            CFRelease(newSize);
            if (resized == kAXErrorSuccess && moved == kAXErrorSuccess) {
                CFTypeRef actualPosition = NULL, actualSize = NULL;
                if (AXUIElementCopyAttributeValue(window, kAXPositionAttribute, &actualPosition) == kAXErrorSuccess &&
                    AXUIElementCopyAttributeValue(window, kAXSizeAttribute, &actualSize) == kAXErrorSuccess &&
                    AXValueGetValue((AXValueRef)actualPosition, kAXValueCGPointType, &point) &&
                    AXValueGetValue((AXValueRef)actualSize, kAXValueCGSizeType, &dimensions) &&
                    CGRectContainsRect(bounds, (CGRect){point, dimensions})) result = 0;
                if (actualPosition != NULL) CFRelease(actualPosition);
                if (actualSize != NULL) CFRelease(actualSize);
            }
        }
    }
    if (result == 0) result = cognia_vd_activate((pid_t)pid, window);
    if (position != NULL) CFRelease(position);
    if (size != NULL) CFRelease(size);
    CFRelease(window);
    return result;
}

uintptr_t cognia_vd_create(CogniaVDGeometry *geometry, int32_t *code) {
    @autoreleasepool {
        [cognia_vd_mutex() lock];
        *code = cognia_vd_check();
        if (*code != 0 || cognia_vd_owned != nil) { if (*code == 0) *code = 10; [cognia_vd_mutex() unlock]; return 0; }
        CogniaVDHandle *handle = [[CogniaVDHandle alloc] init];
        handle.origins = cognia_vd_origins();
        handle.windows = [NSMutableArray array];
        int32_t minimumX = 0;
        for (NSDictionary *saved in handle.origins) minimumX = MIN(minimumX, [saved[@"x"] intValue]);
        handle.physicalOffset = 1920 - minimumX;
        if (handle.origins == nil) { *code = 11; [cognia_vd_mutex() unlock]; return 0; }
        // Dedicated, checked system-only hold. Unlike cognia-power::acquire's
        // best-effort aggregate, failure here denies acquisition. No display
        // assertion and no user-activity declaration is ever installed.
        IOPMAssertionID assertion = 0;
        if (IOPMAssertionCreateWithName(kIOPMAssertionTypePreventUserIdleSystemSleep, kIOPMAssertionLevelOn,
                CFSTR("Cognia screen-off beta"), &assertion) != kIOReturnSuccess) {
            *code = 6; [cognia_vd_mutex() unlock]; return 0;
        }
        handle.assertion = assertion;
        handle.hasAssertion = YES;
        NSNotificationCenter *center = NSWorkspace.sharedWorkspace.notificationCenter;
        __weak CogniaVDHandle *weakHandle = handle;
        handle.sleepObserver = [center addObserverForName:NSWorkspaceWillSleepNotification object:nil queue:nil usingBlock:^(NSNotification *note) {
            (void)note; weakHandle.invalidationCode = 4;
        }];
        handle.sessionObserver = [center addObserverForName:NSWorkspaceSessionDidResignActiveNotification object:nil queue:nil usingBlock:^(NSNotification *note) {
            (void)note; weakHandle.invalidationCode = 3;
        }];
        handle.lockObserver = [NSDistributedNotificationCenter.defaultCenter addObserverForName:@"com.apple.screenIsLocked" object:nil queue:nil usingBlock:^(NSNotification *note) {
            (void)note; weakHandle.invalidationCode = 3;
        }];
        @try {
            id<CogniaVDDescriptor> descriptor = [[NSClassFromString(@"CGVirtualDisplayDescriptor") alloc] init];
            descriptor.name = @"Cognia screen-off beta";
            descriptor.maxPixelsWide = 1920; descriptor.maxPixelsHigh = 1080;
            descriptor.vendorID = 0x4347; descriptor.productID = 0x1080; descriptor.serialNum = (uint32_t)getpid();
            descriptor.sizeInMillimeters = CGSizeMake(508, 286);
            descriptor.redPrimary = CGPointMake(0.64, 0.33); descriptor.greenPrimary = CGPointMake(0.30, 0.60);
            descriptor.bluePrimary = CGPointMake(0.15, 0.06); descriptor.whitePoint = CGPointMake(0.3127, 0.3290);
            descriptor.queue = dispatch_queue_create("com.cognia.virtual-display", DISPATCH_QUEUE_SERIAL);
            id<CogniaVDMode> mode = [(id<CogniaVDMode>)[NSClassFromString(@"CGVirtualDisplayMode") alloc] initWithWidth:1920 height:1080 refreshRate:60.0];
            id<CogniaVDSettings> settings = [[NSClassFromString(@"CGVirtualDisplaySettings") alloc] init];
            settings.hiDPI = 0; settings.modes = @[mode];
            handle.display = [(id<CogniaVDDisplay>)[NSClassFromString(@"CGVirtualDisplay") alloc] initWithDescriptor:descriptor];
            if (handle.display != nil && (![handle.display respondsToSelector:@selector(displayID)] || ![handle.display respondsToSelector:@selector(applySettings:)])) {
                handle.display = nil; *code = 1;
            } else if (handle.display == nil || ![handle.display applySettings:settings]) *code = 10;
            if (*code == 0) {
                BOOL online = NO;
                for (int i = 0; i < 30; i++) {
                    CGDirectDisplayID active[64]; uint32_t count = 0;
                    if (CGGetActiveDisplayList(64, active, &count) == kCGErrorSuccess) {
                        for (uint32_t j = 0; j < count; j++) if (active[j] == handle.display.displayID) online = YES;
                    }
                    if (online) break;
                    usleep(100000);
                }
                if (!online) *code = 8;
            }
            if (*code == 0) {
                CGDisplayConfigRef config = NULL;
                if (CGBeginDisplayConfiguration(&config) != kCGErrorSuccess) *code = 10;
                else {
                    BOOL valid = CGConfigureDisplayOrigin(config, handle.display.displayID, 0, 0) == kCGErrorSuccess;
                    for (NSDictionary *saved in handle.origins) {
                        if (CGConfigureDisplayOrigin(config, [saved[@"id"] unsignedIntValue], [saved[@"x"] intValue] + handle.physicalOffset, [saved[@"y"] intValue]) != kCGErrorSuccess) valid = NO;
                    }
                    if (!valid) { CGCancelDisplayConfiguration(config); *code = 10; }
                    else {
                        // Even a failed completion may partially affect layout.
                        // App-only: WindowServer reverts the origins when this
                        // process exits, so a crash or SIGKILL cannot leave the
                        // physical screens shifted for the rest of the session.
                        handle.layoutChanged = YES;
                        if (CGCompleteDisplayConfiguration(config, kCGConfigureForAppOnly) != kCGErrorSuccess) *code = 10;
                    }
                }
            }
            if (*code == 0) {
                CGRect bounds = CGDisplayBounds(handle.display.displayID);
                if (CGMainDisplayID() != handle.display.displayID || bounds.origin.x != 0 || bounds.origin.y != 0 ||
                    bounds.size.width != 1920 || bounds.size.height != 1080 ||
                    CGDisplayPixelsWide(handle.display.displayID) != 1920 || CGDisplayPixelsHigh(handle.display.displayID) != 1080) *code = 8;
                else *geometry = (CogniaVDGeometry){ handle.display.displayID, bounds.origin.x, bounds.origin.y, bounds.size.width, bounds.size.height };
            }
        } @catch (NSException *exception) {
            (void)exception;
            *code = 1; // selector/ABI missing: unsupported, never crash
        }
        if (*code == 0) *code = handle.invalidationCode != 0 ? handle.invalidationCode : cognia_vd_check();
        if (*code != 0) {
            if (cognia_vd_restore(handle) != 0) *code = 7;
            [cognia_vd_mutex() unlock]; return 0;
        }
        cognia_vd_owned = handle;
        [cognia_vd_mutex() unlock];
        return (uintptr_t)(__bridge_retained void *)handle;
    }
}

int32_t cognia_vd_ping(uintptr_t opaque) {
    @autoreleasepool {
        [cognia_vd_mutex() lock];
        CogniaVDHandle *handle = (__bridge CogniaVDHandle *)(void *)opaque;
        int32_t code = cognia_vd_check();
        if (handle != cognia_vd_owned || handle.display == nil) code = 8;
        else if (handle.invalidationCode != 0 && code == 0) code = handle.invalidationCode;
        else if (code == 0) {
            CGRect bounds = CGDisplayBounds(handle.display.displayID);
            if (!CGDisplayIsActive(handle.display.displayID) || CGMainDisplayID() != handle.display.displayID ||
                bounds.origin.x != 0 || bounds.origin.y != 0 || bounds.size.width != 1920 || bounds.size.height != 1080) code = 8;
        }
        [cognia_vd_mutex() unlock]; return code;
    }
}

int32_t cognia_vd_prepare(uint32_t pid) {
    @autoreleasepool {
        [cognia_vd_mutex() lock];
        int32_t code = cognia_vd_owned == nil ? 8 : cognia_vd_ping((uintptr_t)(__bridge void *)cognia_vd_owned);
        if (code == 0) code = cognia_vd_move_window(cognia_vd_owned, pid);
        [cognia_vd_mutex() unlock]; return code;
    }
}

int32_t cognia_vd_release(uintptr_t opaque) {
    @autoreleasepool {
        [cognia_vd_mutex() lock];
        CogniaVDHandle *handle = (__bridge_transfer CogniaVDHandle *)(void *)opaque;
        int32_t code = 7;
        if (handle == cognia_vd_owned) { cognia_vd_owned = nil; code = cognia_vd_restore(handle); }
        [cognia_vd_mutex() unlock]; return code;
    }
}

// Live input target, for the Rust gate to compare with the application it is
// driving: which process receives keystrokes, and whether that process's
// focused window lies entirely on the owned display. The decision itself is
// in Rust (`input_target_code`) so it is unit-tested.
int32_t cognia_vd_input_state(uint32_t *focused_pid, bool *focused_inside) {
    @autoreleasepool {
        *focused_pid = 0;
        *focused_inside = false;
        [cognia_vd_mutex() lock];
        int32_t code = cognia_vd_owned == nil ? 8 : cognia_vd_ping((uintptr_t)(__bridge void *)cognia_vd_owned);
        if (code == 0) {
            pid_t pid = cognia_vd_focused_pid();
            *focused_pid = (uint32_t)pid;
            if (pid != 0) {
                AXUIElementRef app = AXUIElementCreateApplication(pid);
                AXUIElementSetMessagingTimeout(app, 0.25);
                CFTypeRef window = NULL, position = NULL, size = NULL;
                CGPoint point = CGPointZero; CGSize dimensions = CGSizeZero;
                *focused_inside = AXUIElementCopyAttributeValue(app, kAXFocusedWindowAttribute, &window) == kAXErrorSuccess &&
                    AXUIElementCopyAttributeValue((AXUIElementRef)window, kAXPositionAttribute, &position) == kAXErrorSuccess &&
                    AXUIElementCopyAttributeValue((AXUIElementRef)window, kAXSizeAttribute, &size) == kAXErrorSuccess &&
                    AXValueGetValue((AXValueRef)position, kAXValueCGPointType, &point) &&
                    AXValueGetValue((AXValueRef)size, kAXValueCGSizeType, &dimensions) &&
                    CGRectContainsRect(CGDisplayBounds(cognia_vd_owned.display.displayID), (CGRect){point, dimensions});
                if (window != NULL) CFRelease(window);
                if (position != NULL) CFRelease(position);
                if (size != NULL) CFRelease(size);
                CFRelease(app);
            }
        }
        [cognia_vd_mutex() unlock]; return code;
    }
}

// Tauri can terminate through libc exit before managed-state destructors run.
// Darwin runs image terminators on normal exit. On a hard kill WindowServer
// drops the owned display and reverts the app-only origins, and IOKit drops
// the assertion; moved windows stay where they are (hardware-tested, not
// promised).
__attribute__((destructor)) static void cognia_vd_exit_cleanup(void) {
    @autoreleasepool {
        if (cognia_vd_lock == nil) return;
        [cognia_vd_mutex() lock];
        CogniaVDHandle *handle = cognia_vd_owned;
        cognia_vd_owned = nil;
        if (handle != nil && cognia_vd_restore(handle) != 0) NSLog(@"Cognia screen-off restore_failure during shutdown");
        [cognia_vd_mutex() unlock];
    }
}
