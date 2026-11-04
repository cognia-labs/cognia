// Exercise the production sample-buffer delegate; Rust cannot construct SC frame attachments.
#include "screen_capture.m"
#include <assert.h>

static void deliver_frame(CogniaSCFrameCollector *collector,
                          size_t width,
                          size_t height,
                          CGRect screen_rect,
                          id scale) {
    CVPixelBufferRef pixels = NULL;
    assert(CVPixelBufferCreate(kCFAllocatorDefault, width, height,
                              kCVPixelFormatType_32BGRA,
                              (__bridge CFDictionaryRef)@{(id)kCVPixelBufferIOSurfacePropertiesKey: @{}},
                              &pixels) == kCVReturnSuccess);
    CMVideoFormatDescriptionRef format = NULL;
    assert(CMVideoFormatDescriptionCreateForImageBuffer(kCFAllocatorDefault, pixels, &format) == noErr);
    CMSampleTimingInfo timing = {kCMTimeInvalid, kCMTimeZero, kCMTimeInvalid};
    CMSampleBufferRef sample = NULL;
    assert(CMSampleBufferCreateReadyWithImageBuffer(kCFAllocatorDefault, pixels, format,
                                                   &timing, &sample) == noErr);
    CFArrayRef attachments = CMSampleBufferGetSampleAttachmentsArray(sample, true);
    NSMutableDictionary *info = (__bridge NSMutableDictionary *)CFArrayGetValueAtIndex(attachments, 0);
    info[SCStreamFrameInfoStatus] = @(SCFrameStatusComplete);
    if (scale != nil) {
        info[SCStreamFrameInfoScreenRect] = CFBridgingRelease(CGRectCreateDictionaryRepresentation(screen_rect));
        info[SCStreamFrameInfoScaleFactor] = scale;
    }
    // The delegate does not inspect its non-null sender; only the real sample buffer.
    [collector stream:(SCStream *)(id)collector didOutputSampleBuffer:sample ofType:SCStreamOutputTypeScreen];
    CFRelease(sample);
    CFRelease(format);
    CVPixelBufferRelease(pixels);
}

static void assert_frame(CogniaSCFrameCollector *collector,
                         uint64_t after,
                         size_t width,
                         CGRect expected,
                         double expected_scale) {
    CGRect actual = CGRectNull;
    double scale = 0;
    NSError *error = nil;
    CGImageRef image = [collector copyImageAfterGeneration:after timeout:DISPATCH_TIME_NOW
                                              screenRect:&actual scale:&scale error:&error];
    assert(image != NULL && error == nil);
    assert(CGImageGetWidth(image) == width);
    assert(CGRectEqualToRect(actual, expected));
    assert(scale == expected_scale);
    CGImageRelease(image);
}

int main(void) {
    @autoreleasepool {
        CogniaSCFrameCollector *collector = [[CogniaSCFrameCollector alloc] init];
        CGRect first = CGRectMake(60, 100, 4, 4);
        deliver_frame(collector, 4, 4, first, @1);
        assert_frame(collector, 0, 4, first, 1);

        uint64_t generation = collector.currentGeneration;
        CGRect moved = CGRectMake(-1200, 100, 4, 2);
        deliver_frame(collector, 8, 4, moved, @2);
        assert_frame(collector, generation, 8, moved, 2);

        for (id invalid_scale in @[[NSNull null], @"invalid", @0, @(NAN)]) {
            generation = collector.currentGeneration;
            deliver_frame(collector, 2, 2, first,
                          invalid_scale == NSNull.null ? nil : invalid_scale);
            CGRect rect = CGRectNull;
            double scale = 0;
            NSError *error = nil;
            CGImageRef image = [collector copyImageAfterGeneration:generation timeout:DISPATCH_TIME_NOW
                                                      screenRect:&rect scale:&scale error:&error];
            assert(image == NULL && error != nil);
            // Display capture still supports image-only frames without window metadata.
            image = [collector copyImageAfterGeneration:generation timeout:DISPATCH_TIME_NOW
                                            screenRect:NULL scale:NULL error:NULL];
            assert(image != NULL && CGImageGetWidth(image) == 2);
            CGImageRelease(image);
        }
        CGRect invalid_rects[] = {CGRectZero, CGRectMake(NAN, 100, 4, 4), CGRectMake(60, 100, -1, 4)};
        for (size_t index = 0; index < sizeof(invalid_rects) / sizeof(invalid_rects[0]); index++) {
            generation = collector.currentGeneration;
            deliver_frame(collector, 4, 4, invalid_rects[index], @1);
            CGRect rect = CGRectNull;
            double scale = 0;
            NSError *error = nil;
            CGImageRef image = [collector copyImageAfterGeneration:generation timeout:DISPATCH_TIME_NOW
                                                      screenRect:&rect scale:&scale error:&error];
            assert(image == NULL && error != nil);
        }
        puts("PASS native frame/image geometry pairing and invalid metadata refusal");
    }
    return 0;
}
