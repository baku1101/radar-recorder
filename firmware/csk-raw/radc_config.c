// Independent stopped-only configuration state machine. No arbitrary register API.
#include "radc_config.h"
#include <string.h>
int radc_calibration_location(uint32_t a){return a>=0x2014u&&a<=0x2324u&&((a-0x2014u)%0x100u)<=0x10u&&a%4u==0;}
int radc_profile_valid(const radc_profile_t *p){
 if(!p||!p->id||!p->registers||!p->register_count||p->register_count>4096||!p->chirps||!p->rx||p->rx>3||!p->samples)return 0;
 size_t n=(size_t)p->chirps*p->rx*p->samples;
 return n<=RADC_MAX_SAMPLES&&n%2==0&&p->fifo_threshold==n/2-1;
}
int radc_config_apply(radc_config_state_t *s,const radc_profile_t *profiles,size_t count,const char *id,radc_apply_fn apply,void *context){
 if(s->running)return RADC_CFG_BUSY;const radc_profile_t *p=NULL;
 for(size_t i=0;i<count;i++)if(strcmp(profiles[i].id,id)==0){p=&profiles[i];break;}
 if(!p)return RADC_CFG_UNKNOWN;if(!radc_profile_valid(p))return RADC_CFG_INVALID;
 // A partial write invalidates the previous applied-state claim.
 s->configured=false;if(apply(p,context)!=0)return RADC_CFG_FAILED;s->active=p;s->configured=true;return RADC_CFG_OK;
}
int radc_config_begin(radc_config_state_t *s){if(s->running)return RADC_CFG_BUSY;if(!s->configured)return RADC_CFG_REQUIRED;s->running=true;return RADC_CFG_OK;}
void radc_config_stopped(radc_config_state_t *s){s->running=false;}
