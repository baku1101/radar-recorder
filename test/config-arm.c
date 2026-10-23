/* Synthetic state/encoder harness, executed in ARM emulation, never hardware. */
#include "radc_config.h"
#include "radc_packet.h"
volatile unsigned radc_test_checks;
unsigned char radc_test_wire[128];unsigned radc_test_length;
int strcmp(const char*a,const char*b){while(*a&&*a==*b){a++;b++;}return(unsigned char)*a-(unsigned char)*b;}
void *memset(void*p,int x,size_t n){unsigned char*b=p;for(size_t i=0;i<n;i++)b[i]=(unsigned char)x;return p;}
static void save(const uint8_t*h,size_t hn,const uint8_t*p,size_t pn){for(size_t i=0;i<hn;i++)radc_test_wire[i]=h[i];for(size_t i=0;i<pn;i++)radc_test_wire[hn+i]=p[i];radc_test_length=hn+pn;}
static int apply(const radc_profile_t*p,void*context){(void)p;return *(int*)context;}
void radc_test(void){
 static const uint32_t registers[][2]={{0x100,23}};
 const radc_profile_t profiles[]={{"mock","aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",16,1,16,127,registers,1}};
 radc_config_state_t state={0};int result=0;unsigned checks=0;
 if(radc_config_begin(&state)==RADC_CFG_REQUIRED)checks++;
 if(radc_config_apply(&state,profiles,1,"mock",apply,&result)==0&&state.configured)checks++;
 if(radc_config_begin(&state)==0&&state.running)checks++;
 if(radc_config_apply(&state,profiles,1,"mock",apply,&result)==RADC_CFG_BUSY&&state.configured)checks++;
 radc_config_stopped(&state);
 if(radc_config_apply(&state,profiles,1,"other",apply,&result)==RADC_CFG_UNKNOWN&&state.configured)checks++;
 result=-1;if(radc_config_apply(&state,profiles,1,"mock",apply,&result)==RADC_CFG_FAILED&&!state.configured)checks++;
 if(radc_config_begin(&state)==RADC_CFG_REQUIRED)checks++;
 result=0;if(radc_config_apply(&state,profiles,1,"mock",apply,&result)==0&&radc_config_begin(&state)==0)checks++;
 radc_profile_t invalid=profiles[0];invalid.rx=4;if(!radc_profile_valid(&invalid))checks++;
 if(radc_calibration_location(0x2014)&&!radc_calibration_location(0x100))checks++;
 radc_test_checks=checks;const uint16_t samples[]={0,65535,32768,1};radc_emit_config(samples,4,7,1000,0,profiles[0].config_sha256,save);
}
