import { InvitationList } from '@/invitations/InvitationList';
import { PushPrompt } from '@/push/PushPrompt';
import { Screen } from '@/ui/components';

export default function ReceivedScreen() {
  return (
    <Screen title="Received">
      <InvitationList
        box="received"
        emptyText="No invitations yet. When someone invites you, it shows up here."
        header={<PushPrompt />}
      />
    </Screen>
  );
}
