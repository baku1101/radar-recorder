#ifndef RADC_CONFIG_H
#define RADC_CONFIG_H
#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>
#define RADC_MAX_SAMPLES 8192u
typedef struct {const char *id,*config_sha256,*profile_sha256;uint16_t chirps,rx,samples,fifo_threshold;const uint32_t (*registers)[2];size_t register_count;} radc_profile_t;
typedef struct {const radc_profile_t *active;bool configured,running;} radc_config_state_t;
typedef int (*radc_apply_fn)(const radc_profile_t *,void *);
enum {RADC_CFG_OK=0,RADC_CFG_BUSY=-1,RADC_CFG_UNKNOWN=-2,RADC_CFG_FAILED=-3,RADC_CFG_REQUIRED=-4,RADC_CFG_INVALID=-5};
int radc_profile_valid(const radc_profile_t *p);
int radc_config_apply(radc_config_state_t *s,const radc_profile_t *profiles,size_t count,const char *id,radc_apply_fn apply,void *context);
int radc_config_begin(radc_config_state_t *s);
void radc_config_stopped(radc_config_state_t *s);
int radc_calibration_location(uint32_t address);
#endif
