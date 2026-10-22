"""Replay C3 encryption/event ordering without exposing or bypassing SMP keys."""
import os
from pathlib import Path
import re
import shlex
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]

class HciOrderTests(unittest.TestCase):
    def test_order_failure_disconnect_and_overflow(self):
        source = re.sub(r'^#include[^\n]*\n', '', (ROOT / 'src/ble_hci_order.c').read_text(), flags=re.M)
        with tempfile.TemporaryDirectory() as tmp:
            unit = Path(tmp) / 'test.c'
            unit.write_text('''
#include <assert.h>
#include <stdbool.h>
#include <stdint.h>
#include <stddef.h>
struct device { int unused; };
struct net_buf { uint8_t *data; size_t len; int freed; };
typedef int (*bt_hci_recv_t)(const struct device *, struct net_buf *);
#define BT_HCI_H4_EVT 4
#define BT_HCI_H4_ACL 2
#define BT_HCI_EVT_LE_META_EVENT 0x3e
#define BT_HCI_EVT_LE_LTK_REQUEST 5
#define BT_HCI_EVT_ENCRYPT_CHANGE 8
#define BT_HCI_EVT_DISCONN_COMPLETE 5
static uint16_t sys_get_le16(const uint8_t *p) { return p[0] | (p[1] << 8); }
static void net_buf_unref(struct net_buf *b) { assert(!b->freed); b->freed=1; }
static struct net_buf *seen[32];
static size_t seen_count;
static int receive(const struct device *d, struct net_buf *b) {
 (void)d; seen[seen_count++]=b; return 0;
}
''' + source + '''
int main(void) {
 uint8_t l[]={4,0x3e,13,5,1,0};
 uint8_t a[]={2,1,0,0,0};
 uint8_t e[]={4,8,4,0,1,0,1};
 uint8_t d[]={4,5,4,0,1,0,0x13};
 struct net_buf ltk={l,sizeof(l),0}, enc={e,sizeof(e),0}, disc={d,sizeof(d),0};
 struct net_buf acl[5];
 bt_hci_recv_t rx=linkr_hci_order_init(receive);
 for(int i=0;i<5;i++) acl[i]=(struct net_buf){a,sizeof(a),0};
 rx(0,&ltk); rx(0,&acl[0]); rx(0,&acl[1]);
 assert(seen_count==1);
 rx(0,&enc);
 assert(seen_count==4 && seen[1]==&enc && seen[2]==&acl[0] && seen[3]==&acl[1]);
 rx(0,&acl[2]); assert(seen[4]==&acl[2]);
 // Encryption failure discards queued data.
 rx(0,&ltk); rx(0,&acl[0]); e[3]=1; rx(0,&enc);
 assert(acl[0].freed && pending_count==0);
 // Disconnect and handle reuse cannot replay an older connection's data.
 rx(0,&ltk); rx(0,&acl[1]); rx(0,&disc);
 assert(acl[1].freed && pending_handle==UINT16_MAX);
 // A disconnect ends the quarantine whatever handle it names: with the link
 // gone the quarantined distribution packets can never be used, and gating on
 // the handle leaked up to PENDING_MAX buffers for the rest of the session.
 rx(0,&ltk); rx(0,&acl[2]); assert(pending_count==1);
 d[4]=2; rx(0,&disc);
 assert(pending_count==0 && acl[2].freed && pending_handle==UINT16_MAX);
 d[4]=1;
 // Bounded buffering; unrelated handle events cannot release it.
 for(int i=0;i<5;i++) acl[i].freed=0;
 rx(0,&ltk); for(int i=0;i<5;i++) rx(0,&acl[i]);
 assert(pending_count==4 && acl[4].freed);
 e[3]=0; e[4]=2; rx(0,&enc); assert(pending_count==4);
 rx(0,&disc); assert(pending_count==0);
 for(int i=0;i<5;i++) assert(acl[i].freed);
 return 0;
}
''')
            binary = Path(tmp) / 'test'
            subprocess.run([*shlex.split(os.environ.get('CC','cc')), '-std=c11', '-Wall', '-Wextra', '-Werror', str(unit), '-o', str(binary)], check=True)
            subprocess.run([binary], check=True)
