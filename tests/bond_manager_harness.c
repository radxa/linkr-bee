#include <assert.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <errno.h>
#define ARG_UNUSED(x) (void)(x)
#define K_MUTEX_DEFINE(x) int x
#define K_FOREVER 0
#define K_MSEC(x) (x)
#define BT_SECURITY_L2 2
#define BT_ADDR_STR_LEN 18
#define snprintk snprintf
#define CONFIG_LINKR_BLE_BRIDGE_BOND_LABEL_MAX 48
#define CONFIG_SETTINGS 1
#define IS_ENABLED(x) ((x) != 0)
struct k_work { int unused; };
struct k_work_delayable { void (*fn)(struct k_work *); };
#define K_WORK_DELAYABLE_DEFINE(n,f) struct k_work_delayable n = {f}
static int k_mutex_lock(int *m,int t){(void)m;(void)t;return 0;}
static void k_mutex_unlock(int *m){(void)m;}
static int schedule_error;
static int k_work_reschedule(struct k_work_delayable *w,int t){(void)w;assert(t==500);return schedule_error;}
typedef struct { char text[18]; } bt_addr_t;
typedef struct { uint8_t type; bt_addr_t a; } bt_addr_le_t;
struct bt_bond_info { bt_addr_le_t addr; };
struct bt_conn { int unused; };
struct bt_conn_info { uint8_t id; };
static bt_addr_le_t self={0,{"AA:BB:CC:DD:EE:01"}};
static bool exists=true;
static int security=2, removals;
static int bt_conn_get_info(struct bt_conn*c,struct bt_conn_info*i){(void)c;i->id=0;return 0;}
static int bt_conn_get_security(struct bt_conn*c){(void)c;return security;}
static const bt_addr_le_t *bt_conn_get_dst(struct bt_conn*c){(void)c;return &self;}
static bool bt_addr_le_eq(const bt_addr_le_t*a,const bt_addr_le_t*b){return a->type==b->type&&!strcmp(a->a.text,b->a.text);}
static void bt_addr_le_copy(bt_addr_le_t*a,const bt_addr_le_t*b){*a=*b;}
static int bt_addr_to_str(const bt_addr_t*a,char*b,size_t n){return snprintf(b,n,"%s",a->text);}
static int bt_addr_le_from_str(const char*s,const char*t,bt_addr_le_t*a){if(strcmp(s,self.a.text))return -EINVAL;a->type=!strcmp(t,"random");snprintf(a->a.text,18,"%s",s);return 0;}
static bool bt_le_bond_exists(uint8_t id,const bt_addr_le_t*a){assert(id==0);return exists&&bt_addr_le_eq(a,&self);}
static int bt_unpair(uint8_t id,const bt_addr_le_t*a){assert(id==0&&bt_addr_le_eq(a,&self));exists=false;removals++;return 0;}
static void bt_foreach_bond(uint8_t id,void(*cb)(const struct bt_bond_info*,void*),void*data){assert(id==0);if(exists){struct bt_bond_info b={self};cb(&b,data);}}
/* Label storage is exercised by test_bond_label.py; here the bond manager only
 * needs the symbols to link. */
static int linkr_bond_label_get(const bt_addr_le_t *a,char*o,size_t n){(void)a;(void)o;(void)n;return 0;}
static int linkr_bond_label_set(const bt_addr_le_t *a,const char*s,size_t n){(void)a;(void)s;return (int)n;}
static int linkr_bond_label_clear(const bt_addr_le_t *a){(void)a;return 0;}
#include "bond_production.inc"
int main(void){
 struct bt_conn conn={0};char out[512];
 assert(!linkr_bond_command(&conn,"other",out,sizeof out));
 linkr_bond_command(NULL,"bonds?",out,sizeof out);assert(strstr(out,"ERR"));
 security=1;linkr_bond_command(&conn,"bonds remove 0/AA:BB:CC:DD:EE:01",out,sizeof out);assert(strstr(out,"ERR")&&!pending);security=2;
 linkr_bond_command(&conn,"bonds?",out,sizeof out);assert(strstr(out,"BOND 0/AA:BB:CC:DD:EE:01 self=1"));
 linkr_bond_command(&conn,"bonds?",out,12);assert(strstr(out,"ERR"));
 const char *bad[]={"bonds remove all","bonds remove 2/AA:BB:CC:DD:EE:01","bonds remove 0/AA:BB:CC:DD:EE:01 extra","bonds remove 1/AA:BB:CC:DD:EE:01"};
 for(size_t i=0;i<sizeof bad/sizeof bad[0];i++){linkr_bond_command(&conn,bad[i],out,sizeof out);assert(strstr(out,"ERR")&&!pending);}
 schedule_error=-ENOMEM;linkr_bond_command(&conn,"bonds remove 0/AA:BB:CC:DD:EE:01",out,sizeof out);assert(!pending&&strstr(out,"ERR"));schedule_error=0;
 linkr_bond_command(&conn,"bonds remove 0/AA:BB:CC:DD:EE:01",out,sizeof out);assert(pending&&!removals&&strstr(out,"OK bonds queued"));
 linkr_bond_command(&conn,"bonds remove 0/AA:BB:CC:DD:EE:01",out,sizeof out);assert(strstr(out,"busy"));
 linkr_bond_command(&conn,"bonds?",out,sizeof out);assert(strstr(out,"pending=1"));
 remove_work.fn(NULL);assert(!pending&&removals==1&&!exists);
 linkr_bond_command(&conn,"bonds?",out,sizeof out);assert(strstr(out,"pending=0 result=0")&&!strstr(out,"BOND "));
 linkr_bond_command(&conn,"bonds remove 0/AA:BB:CC:DD:EE:01",out,sizeof out);assert(strstr(out,"not found"));
 return 0;
}
