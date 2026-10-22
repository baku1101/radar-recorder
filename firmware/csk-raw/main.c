/* Independent experimental CSK raw FIFO producer. Device deployment is recorded separately.
 * Board pin facts: pinned Infineon CSK reference resource_map.h/design.modus.
 * The externally supplied official B-step Japan profile is NOT vendored here.
 * Boot remains idle until RADC_START newline. RADC_STOP newline resets the radar
 * FSM. Unknown silicon ID is rejected BEFORE sensor profile writes.
 */
#include "cyhal.h"
#include "cybsp.h"
#include "xensiv_bgt60cutrxx_mtb.h"
#include "xensiv_bgt60cutrxx_regs.h"
#include "radc_packet.h"
#include "radc_private_profile.h"
#include "radc_build_info.h"
#include <string.h>
#include <stdio.h>
#define RADC_TEXT_INNER(x) #x
#define RADC_TEXT(x) RADC_TEXT_INNER(x)
static cyhal_uart_t uart;
static xensiv_bgt60cutrxx_mtb_t sensor;
static volatile uint32_t callback_ms;
static uint16_t samples[SEQ0_NUMBER_OF_CHIRPS*SEQ0_RX_ANTENNAS*SEQ0_SAMPLES_PER_CHIRP];
static uint32_t packet_sequence;
static bool running;
static int32_t startup_status;
static void info(void);
void SysTick_Handler(void){++callback_ms;}
static void uart_bytes(const uint8_t *data,size_t size){
    uint32_t began=callback_ms;
    while(size){size_t n=size;if(cyhal_uart_write(&uart,(void*)data,&n)!=CY_RSLT_SUCCESS){running=false;return;}
        /* HAL write is nonblocking: zero means a temporarily full TX FIFO. */
        if(!n){if((uint32_t)(callback_ms-began)>2000){running=false;return;}continue;}
        data+=n;size-=n;
    }
}
static void message(const char *s){uart_bytes((const uint8_t*)s,strlen(s));}
static void info(void){
    uint32_t id=0,spi_ctrl=0;char text[192];
    sensor.dev.iface=&sensor.iface;
    int status=xensiv_bgt60cutrxx_get_reg(&sensor.dev,BGT60CUTR13B_REG_ID_HW,&id);
    xensiv_bgt60cutrxx_get_reg(&sensor.dev,BGT60CUTR13B_REG_SPI_CTRL,&spi_ctrl);
    message("\nRADC_INFO {\"firmware\":\"radc-0.2.0\",\"protocol\":\"RADC0001\",\"profile_header_sha256\":\"" RADC_PROFILE_SHA256 "\",\"chirps\":" RADC_TEXT(SEQ0_NUMBER_OF_CHIRPS) ",\"rx\":" RADC_TEXT(SEQ0_RX_ANTENNAS) ",\"samples\":" RADC_TEXT(SEQ0_SAMPLES_PER_CHIRP) ",\"register_count\":");
    snprintf(text,sizeof text,"%lu,\"sensor_id_hw\":%lu,\"sensor_id_status\":%d,\"startup_status\":%ld,\"spi_ctrl\":%lu,\"running\":%s}\n",(unsigned long)(sizeof(register_list)/sizeof(register_list[0])),(unsigned long)id,status,(long)startup_status,(unsigned long)spi_ctrl,running?"true":"false");
    message(text);
}
static void write_packet(const uint8_t *h,size_t hn,const uint8_t *p,size_t pn){uart_bytes(h,hn);uart_bytes(p,pn);}
static void stop_radar(void){
    if(running)xensiv_bgt60cutrxx_soft_reset(&sensor.dev,RESET_FSM);
    running=false;message("\nRADC_STOPPED\n");
}
static void start_radar(void){
    if(running){message("\nRADC_ALREADY_RUNNING\n");return;}
    /* Probe only using the documented B-step ID register before profile writes.
     * A-step / unknown IDs do not get this B-step profile. */
    sensor.dev.iface=&sensor.iface; sensor.iface.selpin=P5_3;sensor.iface.rstpin=P10_5;
    uint32_t id=0;
    if(xensiv_bgt60cutrxx_get_reg(&sensor.dev,BGT60CUTR13B_REG_ID_HW,&id)!=0||id!=BGT60CUTR13B_REG_ID_HW_RESET_VAL){message("\nRADC_ERROR_UNSUPPORTED_SILICON_ID\n");return;}
    xensiv_bgt60cutrxx_mtb_iface_config_t pins={.selpin=P5_3,.rstpin=P10_5,.irqpin=P9_3,.irq_priority=3,.spi_mosi=P5_0,.spi_miso=P5_1,.spi_clk=P5_2,.spi_speed_hz=18750000};
    if(xensiv_bgt60cutrxx_platform_init(&sensor,&pins,register_list,sizeof(register_list)/sizeof(register_list[0]),ACTIVE_MODE,false)!=0){message("\nRADC_ERROR_PROFILE_OR_CALIBRATION\n");return;}
    /* Preserve exact configuration readback for audit before streaming. The PC
     * bridge retains these binary records together with the original UART stream.
     * The host must still check masks for volatile fields before accepting it. */
    message("\nRADC_PROFILE_READBACK_BEGIN\n");
    for(size_t i=0;i<sizeof(register_list)/sizeof(register_list[0]);++i){uint32_t value=0;if(xensiv_bgt60cutrxx_get_reg(&sensor.dev,(uint16_t)register_list[i][0],&value)!=0){message("RADC_ERROR_READBACK\n");return;}uint8_t record[8];for(unsigned j=0;j<4;++j){record[j]=(uint8_t)(register_list[i][0]>>(8*j));record[j+4]=(uint8_t)(value>>(8*j));}uart_bytes(record,sizeof record);}
    message("\nRADC_PROFILE_READBACK_END\n");
    if(xensiv_bgt60cutrxx_trigger_sequence0(&sensor.dev)!=0){message("RADC_ERROR_START\n");return;}
    running=true;packet_sequence=0;message("RADC_RUNNING\n");
}
int main(void){
    if(cybsp_init()!=CY_RSLT_SUCCESS)for(;;){}
    __enable_irq();SysTick_Config(SystemCoreClock/1000);
    cyhal_uart_cfg_t cfg={.data_bits=8,.stop_bits=1,.parity=CYHAL_UART_PARITY_NONE,.rx_buffer=NULL,.rx_buffer_size=0};
    if(cyhal_uart_init(&uart,P5_5,P5_4,NC,NC,NULL,&cfg)!=CY_RSLT_SUCCESS)for(;;){}
    if(cyhal_uart_set_baud(&uart,2000000,NULL)!=CY_RSLT_SUCCESS)for(;;){}
    /* Match reference board controls; do not enable Wi-Fi or camera. */
    cyhal_gpio_init(P8_4,CYHAL_GPIO_DIR_OUTPUT,CYHAL_GPIO_DRIVE_STRONG,1);
    cyhal_gpio_init(P9_0,CYHAL_GPIO_DIR_OUTPUT,CYHAL_GPIO_DRIVE_STRONG,1);
    cyhal_gpio_init(P9_2,CYHAL_GPIO_DIR_OUTPUT,CYHAL_GPIO_DRIVE_STRONG,1);
    cyhal_gpio_init(P10_2,CYHAL_GPIO_DIR_OUTPUT,CYHAL_GPIO_DRIVE_STRONG,1);
    cyhal_gpio_init(P9_3,CYHAL_GPIO_DIR_INPUT,CYHAL_GPIO_DRIVE_NONE,0);
    xensiv_bgt60cutrxx_mtb_iface_config_t pins={.selpin=P5_3,.rstpin=P10_5,.irqpin=P9_3,.irq_priority=3,.spi_mosi=P5_0,.spi_miso=P5_1,.spi_clk=P5_2,.spi_speed_hz=18750000};
    if(xensiv_bgt60cutrxx_platform_open(&sensor.iface,&pins)!=0)for(;;){}
    /* platform_open does not populate the CS/reset fields used by driver I/O. */
    sensor.iface.selpin=pins.selpin;sensor.iface.rstpin=pins.rstpin;sensor.dev.iface=&sensor.iface;
    /* ID_HW needs the sensor clock running. Use the official common startup
     * (reset, SPI control check, 80MHz clock and 1.8V I/O) before identity.
     * The RF acquisition profile is still guarded by the B-step ID at START. */
    startup_status=xensiv_bgt60cutrxx_init(&sensor.dev,&sensor.iface.spi,BGT60CUTRXX_CLK_80MHZ,BGT60CUTRXX_IO_LEVEL_1V8,ACTIVE_MODE,false);
    message("\nRADC0001_EXPERIMENTAL_IDLE_BSTEP_ONLY\n");
    char command[32];size_t used=0;
    for(;;){
        uint8_t ch;while(cyhal_uart_readable(&uart)){if(cyhal_uart_getc(&uart,&ch,0)!=CY_RSLT_SUCCESS)break;if(ch=='\n'){command[used]=0;if(strcmp(command,"RADC_START")==0)start_radar();else if(strcmp(command,"RADC_STOP")==0)stop_radar();else if(strcmp(command,"RADC_INFO")==0)info();used=0;}else if(ch!='\r'){if(used<sizeof command-1)command[used++]=(char)ch;else used=0;}}
        if(running&&cyhal_gpio_read(P9_3)){
            uint32_t irq=0;
            if(xensiv_bgt60cutrxx_get_irq_status(&sensor.dev,&irq)!=0){stop_radar();message("RADC_ERROR_IRQ_READ\n");continue;}
            if(irq&(BGT60CUTR13B_IR_STAT_FIFO_OF_ERR_MSK|BGT60CUTR13B_IR_STAT_FIFO_UF_ERR_MSK)){stop_radar();message("RADC_ERROR_FIFO_LOSS\n");continue;}
            if(irq&BGT60CUTR13B_IR_STAT_FIFO_TH_MSK){
                if(xensiv_bgt60cutrxx_get_fifo(&sensor.dev,(fifo_entry_t*)samples,FIFO_THRESHOLD+1)!=0){stop_radar();message("RADC_ERROR_SPI_READ\n");continue;}
                uint32_t tick=callback_ms;
                if(xensiv_bgt60cutrxx_set_irq_clear(&sensor.dev,BGT60CUTR13B_IR_CLEAR_THRESHOLD_MSK)!=0){stop_radar();message("RADC_ERROR_IRQ_CLEAR\n");continue;}
                radc_emit(samples,sizeof(samples)/sizeof(samples[0]),packet_sequence++,tick,0,write_packet);
            }
        }
    }
}
