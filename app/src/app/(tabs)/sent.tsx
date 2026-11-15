import { InvitationList } from '@/invitations/InvitationList';
import { Screen } from '@/ui/components';

export default function SentScreen() {
  return (
    <Screen title="Sent">
      <InvitationList
        box="sent"
        emptyText="You haven't invited anyone yet. Use the Invite tab."
      />
    </Screen>
  );
}
