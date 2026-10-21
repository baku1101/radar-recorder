/* Independent experimental packet encoder. Not an Infineon protocol. */
#ifndef RADAR_RECORDER_RADC_PACKET_H
#define RADAR_RECORDER_RADC_PACKET_H
#include <stdint.h>
#include <stddef.h>
typedef void (*radc_write_fn)(const uint8_t *, size_t, const uint8_t *, size_t);
void radc_emit(const uint16_t *samples, uint32_t sample_count,
               uint32_t packet_sequence, uint32_t callback_tick_ms,
               uint32_t queue_drops, radc_write_fn write_packet);
#endif
