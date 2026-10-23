/* Independent stopped-only profile-config candidate. Private tables are generated
 * offline; this source contains no manufacturer register arrays. */
#include "cyhal.h"
#include "cybsp.h"
#include "xensiv_bgt60cutrxx_mtb.h"
#include "xensiv_bgt60cutrxx_regs.h"
#include "radc_packet.h"
#include "radc_config.h"
#include "radc_private_catalog.h"
#include <string.h>
#include <stdio.h>
static cyhal_uart_t uart;
static xensiv_bgt60cutrxx_mtb_t sensor;
static volatile uint32_t callback_ms;
static uint16_t samples[RADC_MAX_SAMPLES];
static uint32_t packet_sequence;
static radc_config_state_t state;
static int32_t startup_status;
void SysTick_Handler(void){++callback_ms;}
static int uart_bytes(const uint8_t *data,size_t size){
 uint32_t began=callback_ms;
 while(size){size_t n=size;if(cyhal_uart_write(&uart,(void*)data,&n)!=CY_RSLT_SUCCESS)return -1;if(!n){if((uint32_t)(callback_ms-began)>2000)return -1;continue;}data+=n;size-=n;}
 return 0;
}
static void message(const char *s){uart_bytes((const uint8_t*)s,strlen(s));}
static void profile_json(void){
 const radc_profile_t *p=state.configured?state.active:NULL;char text[260];
 if(!p){message("{\"configured\":false}");return;}
 snprintf(text,sizeof text,"{\"configured\":true,\"profile_id\":\"%s\",\"config_sha256\":\"%s\",\"profile_sha256\":\"%s\",",p->id,p->config_sha256,p->profile_sha256);message(text);
 snprintf(text,sizeof text,"\"chirps\":%u,\"rx\":%u,\"samples\":%u,\"register_count\":%lu}",p->chirps,p->rx,p->samples,(unsigned long)p->register_count);message(text);
}
static void info(void){
 uint32_t id=0;int status=xensiv_bgt60cutrxx_get_reg(&sensor.dev,BGT60CUTR13B_REG_ID_HW,&id);char text[192];
 message("\nRADC_INFO {\"firmware\":\"radc-0.3.0\",\"protocol\":\"RADC0002\",\"config_protocol\":\"RADC_CONFIG_1\",\"catalog_sha256\":\"" RADC_CATALOG_SHA256 "\",");
 snprintf(text,sizeof text,"\"sensor_id_hw\":%lu,\"sensor_id_status\":%d,\"startup_status\":%ld,\"running\":%s,\"profile_count\":%u,\"active\":",(unsigned long)id,status,(long)startup_status,state.running?"true":"false",(unsigned)RADC_PROFILE_COUNT);message(text);profile_json();message("}\n");
}
static int apply_profile(const radc_profile_t *p,void *unused){
 (void)unused;uint32_t id=0;
 if(xensiv_bgt60cutrxx_get_reg(&sensor.dev,BGT60CUTR13B_REG_ID_HW,&id)!=0||id!=BGT60CUTR13B_REG_ID_HW_RESET_VAL)return -1;
 xensiv_bgt60cutrxx_mtb_iface_config_t pins={.selpin=P5_3,.rstpin=P10_5,.irqpin=P9_3,.irq_priority=3,.spi_mosi=P5_0,.spi_miso=P5_1,.spi_clk=P5_2,.spi_speed_hz=18750000};
 if(xensiv_bgt60cutrxx_platform_init(&sensor,&pins,p->registers,p->register_count,ACTIVE_MODE,false)!=0)return -1;
 for(size_t i=0;i<p->register_count;i++){uint32_t value;if(xensiv_bgt60cutrxx_get_reg(&sensor.dev,(uint16_t)p->registers[i][0],&value)!=0)return -1;if(!radc_calibration_location(p->registers[i][0])&&value!=p->registers[i][1])return -1;}
 return 0;
}
static void get_config(void){
 if(state.running){message("RADC_ERROR_BUSY\n");return;}if(!state.configured){message("RADC_ERROR_CONFIG_REQUIRED\n");return;}
 message("RADC_CONFIG ");profile_json();message("\nRADC_PROFILE_READBACK_BEGIN\n");const radc_profile_t *p=state.active;
 for(size_t i=0;i<p->register_count;i++){
  uint32_t value=0;if(xensiv_bgt60cutrxx_get_reg(&sensor.dev,(uint16_t)p->registers[i][0],&value)!=0){state.configured=false;message("RADC_ERROR_READBACK\n");return;}
  uint8_t record[8];for(unsigned j=0;j<4;j++){record[j]=(uint8_t)(p->registers[i][0]>>(8*j));record[j+4]=(uint8_t)(value>>(8*j));}if(uart_bytes(record,8)!=0){state.configured=false;return;}
 }
 message("\nRADC_PROFILE_READBACK_END\n");
}
static void set_config(const char *id){
 int result=radc_config_apply(&state,radc_profiles,RADC_PROFILE_COUNT,id,apply_profile,NULL);
 if(result==RADC_CFG_BUSY)message("RADC_ERROR_BUSY\n");else if(result==RADC_CFG_UNKNOWN)message("RADC_ERROR_UNSUPPORTED_PROFILE\n");else if(result!=0)message("RADC_ERROR_CONFIG_APPLY\n");else{message("RADC_CONFIGURED ");profile_json();message("\n");}
}
static void stop_radar(void){
 if(state.running&&xensiv_bgt60cutrxx_soft_reset(&sensor.dev,RESET_FSM)!=0){state.configured=false;radc_config_stopped(&state);message("RADC_ERROR_STOP\n");return;}
 radc_config_stopped(&state);message("\nRADC_STOPPED\n");
}
static void start_radar(void){
 int result=radc_config_begin(&state);if(result==RADC_CFG_BUSY){message("RADC_ALREADY_RUNNING\n");return;}if(result!=0){message("RADC_ERROR_CONFIG_REQUIRED\n");return;}
 if(xensiv_bgt60cutrxx_trigger_sequence0(&sensor.dev)!=0){radc_config_stopped(&state);state.configured=false;message("RADC_ERROR_START\n");return;}
 packet_sequence=0;message("RADC_RUNNING\n");
}
static void write_packet(const uint8_t *h,size_t hn,const uint8_t *p,size_t pn){if(uart_bytes(h,hn)!=0||uart_bytes(p,pn)!=0)stop_radar();}
int main(void){
 if(cybsp_init()!=CY_RSLT_SUCCESS)for(;;){}
 __enable_irq();SysTick_Config(SystemCoreClock/1000);
 cyhal_uart_cfg_t cfg={.data_bits=8,.stop_bits=1,.parity=CYHAL_UART_PARITY_NONE,.rx_buffer=NULL,.rx_buffer_size=0};
 if(cyhal_uart_init(&uart,P5_5,P5_4,NC,NC,NULL,&cfg)!=CY_RSLT_SUCCESS)for(;;){}
 if(cyhal_uart_set_baud(&uart,2000000,NULL)!=CY_RSLT_SUCCESS)for(;;){}
 cyhal_gpio_init(P8_4,CYHAL_GPIO_DIR_OUTPUT,CYHAL_GPIO_DRIVE_STRONG,1);cyhal_gpio_init(P9_0,CYHAL_GPIO_DIR_OUTPUT,CYHAL_GPIO_DRIVE_STRONG,1);cyhal_gpio_init(P9_2,CYHAL_GPIO_DIR_OUTPUT,CYHAL_GPIO_DRIVE_STRONG,1);cyhal_gpio_init(P10_2,CYHAL_GPIO_DIR_OUTPUT,CYHAL_GPIO_DRIVE_STRONG,1);cyhal_gpio_init(P9_3,CYHAL_GPIO_DIR_INPUT,CYHAL_GPIO_DRIVE_NONE,0);
 xensiv_bgt60cutrxx_mtb_iface_config_t pins={.selpin=P5_3,.rstpin=P10_5,.irqpin=P9_3,.irq_priority=3,.spi_mosi=P5_0,.spi_miso=P5_1,.spi_clk=P5_2,.spi_speed_hz=18750000};
 if(xensiv_bgt60cutrxx_platform_open(&sensor.iface,&pins)!=0)for(;;){}
 sensor.iface.selpin=pins.selpin;sensor.iface.rstpin=pins.rstpin;sensor.dev.iface=&sensor.iface;
 startup_status=xensiv_bgt60cutrxx_init(&sensor.dev,&sensor.iface.spi,BGT60CUTRXX_CLK_80MHZ,BGT60CUTRXX_IO_LEVEL_1V8,ACTIVE_MODE,false);
 message("\nRADC_CONFIG_1_CANDIDATE_IDLE\n");char command[96];size_t used=0;bool overflow=false;
 for(;;){
  uint8_t ch;while(cyhal_uart_readable(&uart)){
   if(cyhal_uart_getc(&uart,&ch,0)!=CY_RSLT_SUCCESS)break;
   if(ch=='\n'){
    command[used]=0;
    if(overflow)message("RADC_ERROR_COMMAND_LENGTH\n");else if(strcmp(command,"RADC_INFO")==0)info();else if(strcmp(command,"RADC_START")==0)start_radar();else if(strcmp(command,"RADC_STOP")==0)stop_radar();else if(strcmp(command,"RADC_GETCONFIG")==0)get_config();else if(strncmp(command,"RADC_SETCONFIG ",15)==0)set_config(command+15);else message("RADC_ERROR_UNKNOWN_COMMAND\n");
    used=0;overflow=false;
   }else if(ch!='\r'){if(!overflow&&used<sizeof command-1)command[used++]=(char)ch;else overflow=true;}
  }
  if(state.running&&cyhal_gpio_read(P9_3)){
   uint32_t irq=0;if(xensiv_bgt60cutrxx_get_irq_status(&sensor.dev,&irq)!=0){stop_radar();message("RADC_ERROR_IRQ_READ\n");continue;}
   if(irq&(BGT60CUTR13B_IR_STAT_FIFO_OF_ERR_MSK|BGT60CUTR13B_IR_STAT_FIFO_UF_ERR_MSK)){stop_radar();message("RADC_ERROR_FIFO_LOSS\n");continue;}
   if(irq&BGT60CUTR13B_IR_STAT_FIFO_TH_MSK){const radc_profile_t *p=state.active;
    if(xensiv_bgt60cutrxx_get_fifo(&sensor.dev,(fifo_entry_t*)samples,p->fifo_threshold+1)!=0){stop_radar();message("RADC_ERROR_SPI_READ\n");continue;}
    uint32_t tick=callback_ms;if(xensiv_bgt60cutrxx_set_irq_clear(&sensor.dev,BGT60CUTR13B_IR_CLEAR_THRESHOLD_MSK)!=0){stop_radar();message("RADC_ERROR_IRQ_CLEAR\n");continue;}
    radc_emit_config(samples,(size_t)p->chirps*p->rx*p->samples,packet_sequence++,tick,0,p->config_sha256,write_packet);
   }
  }
 }
}
